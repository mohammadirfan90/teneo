// src/modules/bills/bills.service.ts
//
// Phase 14 minimal facade. POST /bills/generate proxies straight to
// invoices.service.generateInvoiceForLease — utility_share_minor is
// always 0 in Phase 14.
//
// Phase 16 (utility meters + bill-split generation) will replace this
// file with a real implementation that:
//   1. Reads meter readings for the period.
//   2. Computes per-utility totals (electricity, water, gas, internet).
//   3. Splits per lease.utilitySplitMode (EQUAL / PROPORTIONAL / CUSTOM).
//   4. Inserts BillShare rows.
//   5. Generates (or updates) a rent_invoice with utility_share_minor
//      populated from the shares.
//
// Until then, this file is a one-line re-export.

export { generateInvoiceForLease } from '../invoices/invoices.service';