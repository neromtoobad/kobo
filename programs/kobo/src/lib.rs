//! Kobo: pocket money for AI agents.
//!
//! An owner opens an Allowance for one agent key and funds its vault with a
//! stablecoin. The agent can then pay merchants (x402 tool servers) straight
//! from the vault, but only inside the limits the owner set:
//!   - a cap per call,
//!   - a cap per UTC day,
//!   - a budget per merchant (merchants not on the list cannot be paid),
//!   - an expiry time,
//!   - a pause switch the owner can flip at any moment.
//! The agent never holds the funds and never needs SOL: the x402 facilitator
//! pays the network fee and co-signs. Every payment carries a 32-byte
//! reference (the hash of the HTTP request it paid for) in its event, so each
//! receipt can be matched to the exact call it bought.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("2wh8evQ1cAmw3Ykcq5CY1cuTzNp9iFyW9pj7nedEHyVw");

pub const ALLOWANCE_SEED: &[u8] = b"allowance";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MERCHANT_SEED: &[u8] = b"merchant";
pub const DAY: i64 = 86_400;

#[program]
pub mod kobo {
    use super::*;

    /// Open an allowance for `agent` and move `amount` from the owner into its vault.
    /// `payer` covers rent so a sponsor (the facilitator) can onboard owners with no SOL.
    pub fn open(
        ctx: Context<Open>,
        agent: Pubkey,
        per_call_cap: u64,
        daily_cap: u64,
        expires_at: i64,
        amount: u64,
    ) -> Result<()> {
        require!(per_call_cap > 0 && daily_cap >= per_call_cap, KoboError::BadLimits);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, KoboError::BadLimits);

        let a = &mut ctx.accounts.allowance;
        a.owner = ctx.accounts.owner.key();
        a.agent = agent;
        a.mint = ctx.accounts.mint.key();
        a.vault = ctx.accounts.vault.key();
        a.per_call_cap = per_call_cap;
        a.daily_cap = daily_cap;
        a.expires_at = expires_at;
        a.day = now / DAY;
        a.spent_today = 0;
        a.total_spent = 0;
        a.calls = 0;
        a.merchants = 0;
        a.paused = false;
        a.bump = ctx.bumps.allowance;
        a.vault_bump = ctx.bumps.vault;
        a.opened_at = now;

        if amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    SplTransfer {
                        from: ctx.accounts.owner_token.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                amount,
            )?;
        }
        emit!(Opened { allowance: a.key(), owner: a.owner, agent, amount, per_call_cap, daily_cap, expires_at });
        Ok(())
    }

    /// Add funds to the vault.
    pub fn top_up(ctx: Context<OwnerFunds>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.owner_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(ToppedUp { allowance: ctx.accounts.allowance.key(), amount });
        Ok(())
    }

    /// Pull funds back out of the vault to the owner.
    pub fn withdraw(ctx: Context<OwnerFunds>, amount: u64) -> Result<()> {
        let a = &ctx.accounts.allowance;
        vault_transfer(
            a,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.owner_token.to_account_info(),
            ctx.accounts.allowance.to_account_info(),
            ctx.accounts.token_program.key(),
            amount,
        )?;
        emit!(Withdrawn { allowance: a.key(), amount });
        Ok(())
    }

    /// Change the caps and expiry.
    pub fn set_limits(ctx: Context<OwnerOnly>, per_call_cap: u64, daily_cap: u64, expires_at: i64) -> Result<()> {
        require!(per_call_cap > 0 && daily_cap >= per_call_cap, KoboError::BadLimits);
        let a = &mut ctx.accounts.allowance;
        a.per_call_cap = per_call_cap;
        a.daily_cap = daily_cap;
        a.expires_at = expires_at;
        emit!(LimitsSet { allowance: a.key(), per_call_cap, daily_cap, expires_at });
        Ok(())
    }

    /// Kill switch: a paused allowance refuses every payment until unpaused.
    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        let a = &mut ctx.accounts.allowance;
        a.paused = paused;
        emit!(PausedSet { allowance: a.key(), paused });
        Ok(())
    }

    /// Allow a merchant (by its payout wallet) with a total budget. A budget of 0 blocks it.
    pub fn set_merchant(ctx: Context<SetMerchant>, budget: u64) -> Result<()> {
        let m = &mut ctx.accounts.merchant;
        if m.allowance == Pubkey::default() {
            m.allowance = ctx.accounts.allowance.key();
            m.wallet = ctx.accounts.merchant_wallet.key();
            m.bump = ctx.bumps.merchant;
            ctx.accounts.allowance.merchants += 1;
        }
        m.budget = budget;
        emit!(MerchantSet { allowance: m.allowance, merchant: m.wallet, budget });
        Ok(())
    }

    /// The agent pays a merchant from the vault. `reference` is the hash of the
    /// request being paid for, echoed in the event as the receipt.
    pub fn pay(ctx: Context<Pay>, amount: u64, reference: [u8; 32]) -> Result<()> {
        require!(amount > 0, KoboError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.allowance;
        require!(!a.paused, KoboError::Paused);
        require!(now < a.expires_at, KoboError::Expired);
        require!(amount <= a.per_call_cap, KoboError::OverPerCallCap);

        let today = now / DAY;
        if today != a.day {
            a.day = today;
            a.spent_today = 0;
        }
        let spent_today = a.spent_today.checked_add(amount).ok_or(KoboError::Overflow)?;
        require!(spent_today <= a.daily_cap, KoboError::OverDailyCap);

        let m = &mut ctx.accounts.merchant;
        let m_spent = m.spent.checked_add(amount).ok_or(KoboError::Overflow)?;
        require!(m_spent <= m.budget, KoboError::OverMerchantBudget);

        a.spent_today = spent_today;
        a.total_spent = a.total_spent.checked_add(amount).ok_or(KoboError::Overflow)?;
        a.calls += 1;
        m.spent = m_spent;
        m.calls += 1;

        let a = &ctx.accounts.allowance;
        vault_transfer(
            a,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.merchant_token.to_account_info(),
            ctx.accounts.allowance.to_account_info(),
            ctx.accounts.token_program.key(),
            amount,
        )?;
        emit!(Paid {
            allowance: a.key(),
            merchant: m.wallet,
            amount,
            reference,
            call: a.calls,
            spent_today: a.spent_today,
            ts: now,
        });
        Ok(())
    }

    /// Close the allowance: the rest of the vault goes back to the owner and the
    /// rent goes to `rent_to` (whoever sponsored it).
    pub fn close(ctx: Context<Close>) -> Result<()> {
        let a = &ctx.accounts.allowance;
        let left = ctx.accounts.vault.amount;
        if left > 0 {
            vault_transfer(
                a,
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.owner_token.to_account_info(),
                ctx.accounts.allowance.to_account_info(),
                ctx.accounts.token_program.key(),
                left,
            )?;
        }
        let seeds: &[&[u8]] = &[ALLOWANCE_SEED, a.owner.as_ref(), a.agent.as_ref(), &[a.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token::CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.rent_to.to_account_info(),
                authority: ctx.accounts.allowance.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(Closed { allowance: a.key(), returned: left });
        Ok(())
    }
}

fn vault_transfer<'info>(
    a: &Account<'info, Allowance>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    token_program: Pubkey,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[ALLOWANCE_SEED, a.owner.as_ref(), a.agent.as_ref(), &[a.bump]];
    token::transfer(
        CpiContext::new_with_signer(token_program, SplTransfer { from, to, authority }, &[seeds]),
        amount,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Allowance {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub per_call_cap: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
    pub day: i64,
    pub spent_today: u64,
    pub total_spent: u64,
    pub calls: u64,
    pub merchants: u32,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub opened_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Merchant {
    pub allowance: Pubkey,
    pub wallet: Pubkey,
    pub budget: u64,
    pub spent: u64,
    pub calls: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct Open<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Allowance::INIT_SPACE,
        seeds = [ALLOWANCE_SEED, owner.key().as_ref(), agent.as_ref()],
        bump
    )]
    pub allowance: Account<'info, Allowance>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, allowance.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = allowance
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerFunds<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner, has_one = vault)]
    pub allowance: Account<'info, Allowance>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = allowance.mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub allowance: Account<'info, Allowance>,
}

#[derive(Accounts)]
pub struct SetMerchant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub allowance: Account<'info, Allowance>,
    /// CHECK: any wallet can be a merchant; it is only used as a PDA seed and payout owner.
    pub merchant_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Merchant::INIT_SPACE,
        seeds = [MERCHANT_SEED, allowance.key().as_ref(), merchant_wallet.key().as_ref()],
        bump
    )]
    pub merchant: Account<'info, Merchant>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pay<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = agent, has_one = vault)]
    pub allowance: Account<'info, Allowance>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [MERCHANT_SEED, allowance.key().as_ref(), merchant.wallet.as_ref()],
        bump = merchant.bump,
        constraint = merchant.allowance == allowance.key() @ KoboError::UnknownMerchant
    )]
    pub merchant: Account<'info, Merchant>,
    #[account(
        mut,
        associated_token::mint = allowance.mint,
        associated_token::authority = merchant.wallet
    )]
    pub merchant_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, has_one = vault, close = rent_to)]
    pub allowance: Account<'info, Allowance>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = allowance.mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    /// CHECK: receives the rent back; the owner chooses it (normally the sponsor).
    #[account(mut)]
    pub rent_to: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Opened {
    pub allowance: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub amount: u64,
    pub per_call_cap: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
}
#[event]
pub struct ToppedUp {
    pub allowance: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Withdrawn {
    pub allowance: Pubkey,
    pub amount: u64,
}
#[event]
pub struct LimitsSet {
    pub allowance: Pubkey,
    pub per_call_cap: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
}
#[event]
pub struct PausedSet {
    pub allowance: Pubkey,
    pub paused: bool,
}
#[event]
pub struct MerchantSet {
    pub allowance: Pubkey,
    pub merchant: Pubkey,
    pub budget: u64,
}
#[event]
pub struct Paid {
    pub allowance: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub reference: [u8; 32],
    pub call: u64,
    pub spent_today: u64,
    pub ts: i64,
}
#[event]
pub struct Closed {
    pub allowance: Pubkey,
    pub returned: u64,
}

#[error_code]
pub enum KoboError {
    #[msg("Limits are invalid: per-call cap must be > 0, daily cap >= per-call cap, expiry in the future")]
    BadLimits,
    #[msg("Allowance is paused by its owner")]
    Paused,
    #[msg("Allowance has expired")]
    Expired,
    #[msg("Amount is over the per-call cap")]
    OverPerCallCap,
    #[msg("Amount would go over today's cap")]
    OverDailyCap,
    #[msg("Amount would go over this merchant's budget")]
    OverMerchantBudget,
    #[msg("Merchant is not on this allowance")]
    UnknownMerchant,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
}
