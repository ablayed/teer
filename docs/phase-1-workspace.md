# Phase 1 workspace boundary

Phase 1 makes `public.shop` the store/workspace parent for operational data. Shopify
stores retain `store_kind = 'shopify'`; merchants without a connector receive one
idempotent `store_kind = 'manual'` default store. Existing rows are backfilled to the
oldest/default store, and insert-time compatibility triggers keep legacy integrations
from creating a nullable tenant row.

Authenticated workspace URLs are `/s/{storeId}/...`. Middleware carries the URL store
to the server layout, which validates it through `list_my_stores()` before rendering the
existing app screens. The shell displays the active store and links every navigation
destination with the same store prefix. A single-store account skips the chooser.

The future courier boundary is the `shop_member` relation and its `role` check. A courier
identity can be added later as a restricted principal with only the required
`shop_member` rows and a dedicated courier route group. It must not be granted
`merchant_member` organization access or owner/manager financial permissions. The
organization courier-cash view remains available to authorized organization roles, while
the current product has no authenticated courier UI.
