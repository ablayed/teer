-- Lecture seule. À exécuter humainement avec visibilité de toutes les lignes ; jamais via anon/RLS masquant des données.
-- Comptes uniquement. Les shops facultatifs ne sont comparés que lorsque les deux sont non NULL.
-- Une référence nullable absente est légitime. Un résultat positif impose revue, pas nettoyage automatique.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT 'call_log.call_log_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."call_log" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'call_log.call_log_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."call_log" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'cash_settlement.cash_settlement_driver_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."cash_settlement" c LEFT JOIN public."driver" p ON c."driver_id" = p."id"
WHERE c."driver_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'customer.customer_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."customer" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'customer_reliability_projection.customer_reliability_projection_customer_fk' AS reference, count(*) AS inconsistent_count
FROM public."customer_reliability_projection" c LEFT JOIN public."customer" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id" AND c."customer_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL AND c."customer_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'customer_reliability_projection.customer_reliability_projection_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."customer_reliability_projection" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'delivery_address.delivery_address_customer_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."delivery_address" c LEFT JOIN public."customer" p ON c."customer_id" = p."id"
WHERE c."customer_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'delivery_address.delivery_address_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."delivery_address" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'delivery_address.delivery_address_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."delivery_address" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'driver_shop.driver_shop_driver_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."driver_shop" c LEFT JOIN public."driver" p ON c."merchant_account_id" = p."merchant_account_id" AND c."driver_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."driver_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'driver_shop.driver_shop_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."driver_shop" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'expense.expense_category_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."expense" c LEFT JOIN public."expense_category" p ON c."category_id" = p."id"
WHERE c."category_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'external_ref.external_ref_connection_tenant_shop_fk' AS reference, count(*) AS inconsistent_count
FROM public."external_ref" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'external_ref.external_ref_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."external_ref" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'ia_message.ia_message_conversation_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."ia_message" c LEFT JOIN public."ia_conversation" p ON c."conversation_id" = p."id"
WHERE c."conversation_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'ia_tool_audit.ia_tool_audit_conversation_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."ia_tool_audit" c LEFT JOIN public."ia_conversation" p ON c."conversation_id" = p."id"
WHERE c."conversation_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'ingestion_event.ingestion_event_connection_tenant_shop_fk' AS reference, count(*) AS inconsistent_count
FROM public."ingestion_event" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'order_line.order_line_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."order_line" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'order_line.order_line_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."order_line" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'order_line.order_line_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."order_line" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'order_state_transition.order_state_transition_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."order_state_transition" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'order_state_transition.order_state_transition_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."order_state_transition" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'orders.orders_customer_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."orders" c LEFT JOIN public."customer" p ON c."customer_id" = p."id"
WHERE c."customer_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'orders.orders_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."orders" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'orders.orders_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."orders" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'orders.orders_store_connection_tenant_shop_fk' AS reference, count(*) AS inconsistent_count
FROM public."orders" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'pcd_access_audit.pcd_access_audit_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."pcd_access_audit" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."tenant_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'pcd_access_quota_bucket.pcd_access_quota_bucket_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."pcd_access_quota_bucket" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."tenant_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'product.product_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."product" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'product_ad_spend.product_ad_spend_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."product_ad_spend" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'product_ad_spend.product_ad_spend_purchase_lot_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."product_ad_spend" c LEFT JOIN public."purchase_lot" p ON c."purchase_lot_id" = p."id"
WHERE c."purchase_lot_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'product_ad_spend.product_ad_spend_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."product_ad_spend" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'product_bundle_component.product_bundle_component_bundle_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."product_bundle_component" c LEFT JOIN public."product" p ON c."bundle_product_id" = p."id"
WHERE c."bundle_product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'product_bundle_component.product_bundle_component_component_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."product_bundle_component" c LEFT JOIN public."product" p ON c."component_product_id" = p."id"
WHERE c."component_product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'product_bundle_component.product_bundle_component_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."product_bundle_component" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'product_stock.product_stock_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."product_stock" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'product_stock.product_stock_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."product_stock" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'purchase_lot.purchase_lot_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'purchase_lot_cost_correction.purchase_lot_cost_correction_purchase_lot_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_cost_correction" c LEFT JOIN public."purchase_lot" p ON c."purchase_lot_id" = p."id"
WHERE c."purchase_lot_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_cost_correction.purchase_lot_cost_correction_purchase_lot_line_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_cost_correction" c LEFT JOIN public."purchase_lot_line" p ON c."purchase_lot_line_id" = p."id"
WHERE c."purchase_lot_line_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_cost_correction.purchase_lot_cost_correction_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_cost_correction" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'purchase_lot_line.purchase_lot_line_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line.purchase_lot_line_purchase_lot_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line" c LEFT JOIN public."purchase_lot" p ON c."purchase_lot_id" = p."id"
WHERE c."purchase_lot_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line.purchase_lot_line_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'purchase_lot_line_allocation.purchase_lot_line_allocation_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line_allocation" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line_allocation.purchase_lot_line_allocation_order_line_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line_allocation" c LEFT JOIN public."order_line" p ON c."order_line_id" = p."id"
WHERE c."order_line_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line_allocation.purchase_lot_line_allocation_purchase_lot_line_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line_allocation" c LEFT JOIN public."purchase_lot_line" p ON c."purchase_lot_line_id" = p."id"
WHERE c."purchase_lot_line_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line_allocation.purchase_lot_line_allocation_recognized_transition_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line_allocation" c LEFT JOIN public."order_state_transition" p ON c."recognized_transition_id" = p."id"
WHERE c."recognized_transition_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'purchase_lot_line_allocation.purchase_lot_line_allocation_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."purchase_lot_line_allocation" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'settlement_allocation.settlement_allocation_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."settlement_allocation" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'settlement_allocation.settlement_allocation_settlement_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."settlement_allocation" c LEFT JOIN public."cash_settlement" p ON c."settlement_id" = p."id"
WHERE c."settlement_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'settlement_shortfall.settlement_shortfall_driver_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."settlement_shortfall" c LEFT JOIN public."driver" p ON c."driver_id" = p."id"
WHERE c."driver_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'settlement_shortfall.settlement_shortfall_settlement_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."settlement_shortfall" c LEFT JOIN public."cash_settlement" p ON c."settlement_id" = p."id"
WHERE c."settlement_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'shop_member.shop_member_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shop_member" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'shop_member.shop_member_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."shop_member" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'shopify_customer_redaction_tombstone.shopify_customer_redaction_tombstone_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shopify_customer_redaction_tombstone" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'shopify_dsar_artifact.shopify_dsar_artifact_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shopify_dsar_artifact" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'shopify_dsar_artifact.shopify_dsar_artifact_webhook_event_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shopify_dsar_artifact" c LEFT JOIN public."webhook_event" p ON c."webhook_event_id" = p."id"
WHERE c."webhook_event_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'shopify_dsar_download_authorization.shopify_dsar_download_authorization_artifact_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shopify_dsar_download_authorization" c LEFT JOIN public."shopify_dsar_artifact" p ON c."artifact_id" = p."id"
WHERE c."artifact_id" IS NOT NULL
  AND (p."id" IS NULL OR c."tenant_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'shopify_dsar_download_authorization.shopify_dsar_download_authorization_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."shopify_dsar_download_authorization" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."tenant_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'stock_movement.stock_movement_driver_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."stock_movement" c LEFT JOIN public."driver" p ON c."driver_id" = p."id"
WHERE c."driver_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'stock_movement.stock_movement_order_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."stock_movement" c LEFT JOIN public."orders" p ON c."order_id" = p."id"
WHERE c."order_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'stock_movement.stock_movement_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."stock_movement" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'stock_movement.stock_movement_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."stock_movement" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'stock_movement.stock_movement_transition_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."stock_movement" c LEFT JOIN public."order_state_transition" p ON c."transition_id" = p."id"
WHERE c."transition_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'stock_reconciliation_alert.stock_reconciliation_alert_product_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."stock_reconciliation_alert" c LEFT JOIN public."product" p ON c."product_id" = p."id"
WHERE c."product_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'store_connection.store_connection_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."store_connection" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'store_connection_credential.store_connection_credential_connection_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."store_connection_credential" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'store_connection_intent.store_connection_intent_created_by_member_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."store_connection_intent" c LEFT JOIN public."merchant_member" p ON c."created_by_member_id" = p."id"
WHERE c."created_by_member_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'store_connection_intent.store_connection_intent_shop_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."store_connection_intent" c LEFT JOIN public."shop" p ON c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."id"
WHERE c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."merchant_account_id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
UNION ALL
SELECT 'store_connection_sync_state.store_connection_sync_state_connection_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."store_connection_sync_state" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'store_connection_webhook_subscription.store_connection_webhook_subscription_connection_tenant_fk' AS reference, count(*) AS inconsistent_count
FROM public."store_connection_webhook_subscription" c LEFT JOIN public."store_connection" p ON c."store_connection_id" = p."id" AND c."merchant_account_id" = p."merchant_account_id" AND c."shop_id" = p."shop_id"
WHERE c."store_connection_id" IS NOT NULL AND c."merchant_account_id" IS NOT NULL AND c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id" OR (c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id))
UNION ALL
SELECT 'webhook_event.webhook_event_shop_id_fkey' AS reference, count(*) AS inconsistent_count
FROM public."webhook_event" c LEFT JOIN public."shop" p ON c."shop_id" = p."id"
WHERE c."shop_id" IS NOT NULL
  AND (p."id" IS NULL OR c."merchant_account_id" IS DISTINCT FROM p."merchant_account_id")
ORDER BY reference;
ROLLBACK;
