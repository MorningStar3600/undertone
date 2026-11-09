# Personal music UI

`TrackMoods.vue` is ready for a future dock parent. Its props are:

```ts
{
	trackId: string; // Stable catalogue UUID, not a provider reference.
	contributorMoodIds: string[]; // Supplied by future targeted room sync.
	contributorMoods?: Mood[]; // Optional public vocabulary metadata for these IDs.
}
```

Priority icons are the deduplicated contributor IDs. Complementary icons are the
viewer's loaded personal tags plus favorite shortcuts, minus the priority IDs.
Only the viewer's tags set `aria-pressed` and the scoped blue token. Unknown
contributor vocabulary has an explicit unavailable state until public metadata
is supplied or discovered. No contributor identity or private annotations are fetched.
Library passes an empty contributor group and displays personal tags and favorites.

`useMusic()` shares favorites and discovered vocabulary per existing Vuex store.
It exposes `authorized`, `expired`, `version`, `moods`, `remember(moods)`,
`request<T>(method, path, data?, params?, controller?)`, `favorites`,
`favoritePending`, `favoriteError`, and `setFavorite(mood, active)`.
Requests use the application's axios instance and existing auth token/cookie.
Logout, a replacement account, or token renewal aborts requests and clears private
state synchronously. Responses from old sessions cannot repopulate it. The cache
is also disposed when the last music consumer unmounts; nothing private is stored
in browser storage by this feature. A 401/403 locks further calls until login/token renewal.

`useMusicAnnotations(trackId: Ref<string | null>)` exposes
`{ music, page, pending, error, setTag(mood, active) }`.
Changing the track resets tags immediately and ignores previous reads/writes.
Writes use idempotent PUT/DELETE and commit UI state after server confirmation.
Creating an existing normalized mood selects it, rather than toggling it off.
Favorites, tags and library membership use separate endpoints.

`useMusicPage<T>(session, path: () => string | null, pageSize = 20)` exposes
`items`, `total`, `offset`, `limit`, `loading`, `error`, `hasMore`,
`load(offset?, append?)`, `retry()` and `loadMore()`.
Library and shared mood discovery use 20-item pages; annotations/favorites use
100-item pages with explicit load-more buttons. No catalogue is silently drained.
If a partially loaded tag/favorite list changes, its first page is refreshed to
avoid skipping entries as offset positions change. Search filters the visible
shared vocabulary page: the existing API accepts only `limit` and `offset`, no
search query. Imports accept one URL or explicit provider reference, never a playlist.

This module does not implement room filters, mix scheduling, recommendations or
playback. Future dock integration must supply the real current track and synced
contributor IDs, and retain accessible transport controls when opening its panel.
