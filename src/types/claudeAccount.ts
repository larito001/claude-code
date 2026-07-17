export type SubscriptionType = 'max' | 'pro' | 'team' | 'enterprise'

export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | string

export type ReferralCampaign = string

export type ReferrerRewardInfo = {
  currency: string
  amount_minor_units: number
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  remaining_passes?: number
  referrer_reward?: ReferrerRewardInfo | null
  referral_code_details?: {
    referral_link?: string
    campaign?: ReferralCampaign
  }
}

export type ReferralRedemptionsResponse = {
  redemptions?: unknown[]
  limit?: number
}
