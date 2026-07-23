# Preuve — Shopify Support : Billing API

- Rattachement : Teer Public
- Expéditeur : Rob P. (Shopify Support)
- Reçu le : 23 juillet 2026, 13:54 EDT
- App ID : [NON DISPONIBLE — à compléter par Ablaye depuis le Partner Dashboard/l'historique email]
- Numéro de ticket : [NON DISPONIBLE — à compléter par Ablaye depuis le Partner Dashboard/l'historique email]

## Message intégral

Rob (Shopify)

Jul 23, 2026, 13:54 EDT

Hi Ablaye,

Thank you for your detailed explanation of Tëër’s business model and for outlining your billing questions so clearly. I want to give you a direct answer to each point and not just refer you to general policy.

Shopify Billing API Requirement & Exemption:
Tëër does not qualify for a Billing API exemption under the model you described, and Shopify cannot provide written authorization for off-platform billing for merchants who install your app through the Shopify App Store. Here’s how this applies to your questions:

Exemptions from the Billing API are only granted when the app is solely a connector to a third-party platform you do not own or control. Since Tëër is your proprietary SaaS and you control the billing infrastructure, the exemption does not apply. This is true even if your subscription covers non-Shopify stores, the connector is free to install, or your listing uses limited visibility.

Addressing your specific requests:

Distribution as a public app:
You can offer the Shopify connector as a public app and use limited visibility if you’d like. But limited visibility does not change the requirement to use Shopify Billing for any paid features accessed by merchants via the App Store.

2 & 3. Merchant-account-level external subscription:
Merchants who install the app via the App Store and gain access to paid features must be billed for those features through Shopify Billing regardless of whether their subscription would also cover non-Shopify stores. Only merchants who were already paying Tëër customers prior to connecting Shopify are exempt from migration to Shopify Billing.

Avoiding Shopify Billing for multi-platform/SaaS:
Owning both the SaaS and billing infrastructure, or supporting multiple platforms, is not grounds for an exemption. Shopify’s policy is clear: “I already have a billing system” and “my app is on multiple platforms” do not qualify for off-platform billing for merchants installing through the App Store.

Merchant onboarding through your own site:
It’s fine to direct merchants to your website to create their account, but if they install the Shopify app from the App Store, any charges for paid features must still go through Shopify Billing.

Exemption request process:
Exemptions are assessed during app review. If you’d still like to submit a request, provide your specific justification at the top of your Test Instructions when submitting the app for review. However, based on the model outlined, this request does not meet the approval criteria. We want to be upfront so you can make the best decision for your architecture before submitting.

Next steps:
Our developer documentation covers how to set up Shopify Billing for SaaS and multi-tier apps, and includes guidance on handling pre-existing subscribers:
https://shopify.dev/docs/apps/launch/billing

If you have other questions about implementation or want to discuss your billing setup, Shopify Support is here 24/7 and happy to help.

All the best,
Rob P | Shopify Support Team
