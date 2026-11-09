/** Async permission/session validation plus a synchronous connection lifetime fence. */
export type PlaybackAuthorization = (() => void | Promise<void>) & {
	assertCurrent?: () => void;
};
