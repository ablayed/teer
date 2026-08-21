-- 0135: restore transition_order access to the internal stock engine.
--
-- 0134 revoked the twelve-argument engine from authenticated, but
-- transition_order is SECURITY INVOKER and therefore calls it as
-- authenticated during the real COD workflow. This is a minimal roll-forward;
-- the public 13-argument capability and its shop guards remain unchanged.

grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, bigint, text, uuid
) to authenticated;
