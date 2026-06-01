-- Applied manually in Supabase SQL Editor before this migration was versioned.
-- Keep this file in migration history so subsequent migrations start at 0011.
DROP FUNCTION IF EXISTS get_dashboard_kpi(uuid);

CREATE OR REPLACE FUNCTION get_dashboard_kpi(p_merchant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_a_appeler_count     integer;
  v_a_appeler_yesterday integer;
  v_ca_collecte_7j      numeric;
  v_ca_en_attente       numeric;
  v_taux_confirmation   numeric;
  v_taux_livraison      numeric;
  v_sparkline           jsonb;
BEGIN

  SELECT COUNT(*) INTO v_a_appeler_count
  FROM orders
  WHERE merchant_account_id = p_merchant_id
    AND cod_status = 'A_APPELER';

  SELECT COUNT(*) INTO v_a_appeler_yesterday
  FROM orders
  WHERE merchant_account_id = p_merchant_id
    AND cod_status = 'A_APPELER'
    AND created_at < NOW() - INTERVAL '1 day';

  SELECT COALESCE(SUM(total_amount), 0) INTO v_ca_collecte_7j
  FROM orders
  WHERE merchant_account_id = p_merchant_id
    AND cod_status = 'LIVREE'
    AND created_at >= NOW() - INTERVAL '7 days';

  SELECT COALESCE(SUM(total_amount), 0) INTO v_ca_en_attente
  FROM orders
  WHERE merchant_account_id = p_merchant_id
    AND cod_status IN ('CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON');

  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN 0
      ELSE ROUND(
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM order_state_transition ost
            WHERE ost.order_id = o.id
              AND ost.to_status = 'CONFIRMEE'
          )
        ) * 100.0 / COUNT(*), 2
      )
    END INTO v_taux_confirmation
  FROM orders o
  WHERE o.merchant_account_id = p_merchant_id
    AND o.created_at >= NOW() - INTERVAL '30 days';

  SELECT
    CASE
      WHEN (
        COUNT(*) FILTER (WHERE cod_status = 'LIVREE') +
        COUNT(*) FILTER (
          WHERE cod_status IN ('REFUSEE', 'ANNULEE')
          AND EXISTS (
            SELECT 1 FROM order_state_transition ost
            WHERE ost.order_id = id
              AND ost.to_status = 'CONFIRMEE'
          )
        )
      ) = 0 THEN 0
      ELSE ROUND(
        COUNT(*) FILTER (WHERE cod_status = 'LIVREE') * 100.0 /
        (
          COUNT(*) FILTER (WHERE cod_status = 'LIVREE') +
          COUNT(*) FILTER (
            WHERE cod_status IN ('REFUSEE', 'ANNULEE')
            AND EXISTS (
              SELECT 1 FROM order_state_transition ost
              WHERE ost.order_id = id
                AND ost.to_status = 'CONFIRMEE'
            )
          )
        ), 2
      )
    END INTO v_taux_livraison
  FROM orders
  WHERE merchant_account_id = p_merchant_id;

  SELECT jsonb_agg(
    jsonb_build_object('date', day::date, 'value', COALESCE(daily_total, 0))
    ORDER BY day
  ) INTO v_sparkline
  FROM (
    SELECT generate_series(
      DATE_TRUNC('day', NOW()) - INTERVAL '6 days',
      DATE_TRUNC('day', NOW()),
      INTERVAL '1 day'
    ) AS day
  ) days
  LEFT JOIN (
    SELECT DATE_TRUNC('day', created_at) AS order_day, SUM(total_amount) AS daily_total
    FROM orders
    WHERE merchant_account_id = p_merchant_id
      AND cod_status = 'LIVREE'
      AND created_at >= NOW() - INTERVAL '7 days'
    GROUP BY 1
  ) totals ON totals.order_day = days.day;

  RETURN jsonb_build_object(
    'a_appeler_count',   v_a_appeler_count,
    'a_appeler_delta',   v_a_appeler_count - v_a_appeler_yesterday,
    'ca_collecte_7j',    v_ca_collecte_7j,
    'ca_en_attente',     v_ca_en_attente,
    'taux_confirmation', v_taux_confirmation,
    'taux_livraison',    v_taux_livraison,
    'sparkline_7j',      v_sparkline
  );
END;
$$;
