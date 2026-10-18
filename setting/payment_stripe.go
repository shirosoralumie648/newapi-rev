package setting

var StripeApiSecret = ""
var StripeWebhookSecret = ""
var StripePriceId = ""
var StripeUnitPrice = 8.0
var StripeMinTopUp = 1
var StripePromotionCodesEnabled = false

// StripeAutoInvoiceEnabled asks Stripe to generate an invoice for each top-up
// checkout session (#3204). Default off: invoices need the Stripe account to
// have billing/tax configured, so self-hosters opt in explicitly.
var StripeAutoInvoiceEnabled = false
