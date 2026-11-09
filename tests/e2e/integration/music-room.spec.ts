/* eslint-env browser */
import { describe, expect, it } from "../support/fixtures";
const MUSIC_OPTION = /^Music/;

// Uses the real room API/WebSocket, with an empty guest library and no provider mocks.
// Requires the music SQL migrations and the normal OTT E2E services.
describe("Collective music room", () => {
	it("enters Music, applies guest filters, reads the full queue, and leaves transport available at 320px", async ({
		page,
		ott,
	}) => {
		await ott.ensureToken();
		const response = await ott.request({ method: "POST", url: "/api/room/generate" });
		const { room } = await response.json();
		await page.goto(`/room/${room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		await page.getByRole("tab", { name: "Settings", exact: true }).click();
		await page.locator('[data-cy="select-queueMode"]').click();
		await page.getByRole("option", { name: MUSIC_OPTION }).click();
		await page.getByRole("button", { name: "Save", exact: true }).click();
		const filters = page.locator('[data-cy="music-filters"]');
		await expect(filters).toBeVisible();
		await filters.getByRole("button", { name: "Include focus", exact: true }).click();
		await filters.getByRole("button", { name: "Exclude energetic", exact: true }).click();
		await filters.locator('[data-cy="music-apply-filters"]').click();
		await expect(page.getByText("Action accepted.", { exact: true })).toBeVisible();
		await expect(
			filters.getByRole("button", { name: "Exclude energetic", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("tab", { name: "Queue", exact: true }).click();
		await page.locator('[data-cy="music-full-queue"]').click();
		await expect(
			page.getByText("No tracks admitted yet. Add a track or adjust the room filters.", {
				exact: true,
			}),
		).toBeVisible();
		await page.setViewportSize({ width: 320, height: 640 });
		await expect(page.locator('[data-cy="playback-skip"]')).toBeVisible();
		await expect(page.locator('[data-cy="volume-slider"]')).toBeVisible();
		await expect(page.locator('[data-cy="room-player-dock"]')).toHaveCount(1);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
});
