<template>
	<RoomPlayerLayout :fullscreen="store.state.fullscreen">
		<!-- HACK: For some reason, safari really doesn't like typescript enums. As a result, we are forced to not use the enums, and use their literal values instead. -->
		<div
			class="room-content group/room p-4 max-xl:p-0 data-[fullscreen=true]:p-0 data-[layout=theater]:p-0"
			:data-fullscreen="store.state.fullscreen"
			:data-layout="store.state.settings.roomLayout"
			v-if="!showDisconnectedOverlay"
		>
			<div
				class="mx-2.5 flex flex-row flex-wrap items-center gap-2"
				v-if="!store.state.fullscreen"
			>
				<h1
					class="relative min-w-0 max-w-full break-words pl-4 font-display text-foreground text-2xl before:absolute before:left-0 before:inset-y-[0.1em] before:w-1 before:bg-primary before:shadow-[0_0_12px_var(--primary)] before:content-['']"
				>
					{{
						store.state.room.title !== ""
							? store.state.room.title
							: store.state.room.isTemporary
							? $t("room.title-temp")
							: store.state.room.name
					}}
				</h1>
				<ClientSettingsDialog />
				<ChatPlacementToggle :in-video-allowed="inVideoChatAllowed" class="ml-2" />
				<div class="flex items-center text-sm font-medium uppercase ml-auto">
					<Tooltip>
						<TooltipTrigger as-child>
							<Button
								data-cy="room-visibility"
								variant="ghost"
								size="sm"
								@click="onVisibilityClick"
							>
								<Icon :icon="roomVisibilityIcon" class="size-4" />
								{{ roomVisibilityLabel }}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">
							{{ $t("room.visibility-badge-label") }}
						</TooltipContent>
					</Tooltip>
					<Icon
						:icon="mdiCircle"
						class="ml-2 size-3"
						:class="
							connectionStatusColor === 'success' ? 'text-success' : 'text-warning'
						"
					/>
					<span id="connectStatus" class="ml-1 label-mono">{{ connectionStatus }}</span>
				</div>
			</div>
			<div class="room-media-grid">
				<div class="relative z-31 min-h-0 min-w-0">
					<div class="relative size-full">
						<OmniPlayer
							:source="store.state.room.currentSource"
							@apiready="onPlayerApiReady"
							@playing="onPlaybackChange(true)"
							@paused="onPlaybackChange(false)"
							@ready="onPlayerReady"
						/>
						<div
							class="pointer-events-none absolute bottom-20 right-0 h-[70%] min-h-17.5 w-100 px-2.5 py-1.25 max-lg:w-62.5"
							v-if="showInVideoChat"
						>
							<Chat ref="chat" @link-click="setAddPreviewText" />
						</div>
						<div
							class="absolute inset-0 z-200 flex items-center justify-center"
							v-if="mediaPlaybackBlocked"
						>
							<Button size="xl" variant="default" @click="onClickUnblockPlayback">
								<Icon :icon="mdiPlay" class="size-5" />
								{{ $t("common.play") }}
							</Button>
						</div>
					</div>
				</div>
				<div
					v-if="showChatPanel"
					class="flex h-full max-lg:h-[60vh] max-lg:w-full"
					data-cy="room-side-panel"
				>
					<ResizeHandle
						v-model="chatPanelWidth"
						:label="$t('chat.resize-panel')"
						:direction="-1"
						:min="CHAT_PANEL_MIN_WIDTH"
						:default-size="DEFAULT_CHAT_PANEL_WIDTH"
						class="max-lg:hidden"
					/>
					<div
						class="h-full px-2 max-lg:w-full!"
						:style="{ width: `${chatPanelWidth}px` }"
					>
						<RoomSidePanel v-model:tab="sidePanelTab">
							<template #actions>
								<Button
									v-if="inVideoChatAllowed"
									variant="ghost"
									size="icon-sm"
									:aria-label="$t('chat.move-into-video')"
									:title="$t('chat.move-into-video')"
									@click="moveChatIntoVideo"
								>
									<Icon :icon="mdiPictureInPictureBottomRight" class="size-4" />
								</Button>
							</template>
							<template #chat>
								<Chat
									ref="chat"
									always-visible
									hide-header
									@link-click="setAddPreviewText"
								/>
							</template>
							<template #users>
								<UserList :users="Array.from(store.state.users.users.values())" />
							</template>
						</RoomSidePanel>
					</div>
				</div>
			</div>
			<div class="my-2.5" v-show="!store.state.fullscreen">
				<RestoreQueue />
			</div>
			<div class="flex min-w-0 w-full max-lg:flex-col" v-show="!store.state.fullscreen">
				<div class="min-w-0 w-3/5 grow max-lg:w-full">
					<Tabs v-model="queueTab" class="overflow-visible">
						<TabsList class="w-full">
							<TabsTrigger
								value="queue"
								class="flex-1 gap-2"
								:aria-label="$t('room.tabs.queue')"
							>
								<Icon :icon="mdiFormatListBulleted" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{ $t("room.tabs.queue") }}</span>
								<Badge variant="secondary" class="ml-1">
									{{
										store.state.room.queue.length <= 99
											? $n(store.state.room.queue.length)
											: "99+"
									}}
								</Badge>
							</TabsTrigger>
							<TabsTrigger
								value="add"
								class="flex-1 gap-2"
								:aria-label="$t('common.add')"
							>
								<Icon :icon="mdiPlus" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{ $t("common.add") }}</span>
							</TabsTrigger>
							<TabsTrigger
								value="settings"
								class="flex-1 gap-2"
								:aria-label="$t('room.tabs.settings')"
							>
								<Icon :icon="mdiWrench" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{
									$t("room.tabs.settings")
								}}</span>
							</TabsTrigger>
						</TabsList>

						<TabsContentAnimatedGroup>
							<TabsContentAnimated value="queue">
								<VideoQueue @switchtab="queueTab = 'add'" />
							</TabsContentAnimated>
							<TabsContentAnimated value="add">
								<AddPreview ref="addpreview" />
							</TabsContentAnimated>
							<TabsContentAnimated value="settings">
								<RoomSettingsForm ref="settings" />
							</TabsContentAnimated>
						</TabsContentAnimatedGroup>
					</Tabs>
				</div>
				<div class="flex min-h-125 flex-col gap-2.5 px-2.5">
					<div v-if="debugMode">
						<Card>
							<CardHeader>
								<CardTitle>Debug (prod: {{ production }})</CardTitle>
							</CardHeader>
							<CardContent
								class="flex flex-col gap-1 font-mono text-xs text-muted-foreground"
							>
								<div>Player status: {{ store.state.playerStatus }}</div>
								<div v-if="store.state.playerBufferPercent">
									Buffered:
									{{ Math.round(store.state.playerBufferPercent * 10000) / 100 }}%
								</div>
								<div
									v-if="
										store.state.playerBufferSpans &&
										store.state.playerBufferSpans.length > 0
									"
								>
									Buffered spans:
									{{ store.state.playerBufferSpans.length }}
									{{
										Array.from(
											{ length: store.state.playerBufferSpans.length },
											(v, k) => k++,
										)
											.map(
												i =>
													`${i}: [${secondsToTimestamp(
														store.state.playerBufferSpans?.start(i) ??
															0,
													)} => ${secondsToTimestamp(
														store.state.playerBufferSpans?.end(i) ?? 0,
													)}]`,
											)
											.join(" ")
									}}
								</div>
								<div>Is Mobile: {{ isMobile }}</div>
								<div>Device Orientation: {{ orientation }}</div>
								<div class="mt-2 flex gap-2">
									<Button
										size="sm"
										variant="outline"
										@click="roomapi.kickMe()"
										:disabled="!isConnected"
									>
										{{ $t("room.kick-me") }}
									</Button>
									<Button
										size="sm"
										variant="outline"
										@click="roomapi.kickMe(1000)"
										:disabled="!isConnected"
									>
										Disconnect Me
									</Button>
								</div>
							</CardContent>
						</Card>
					</div>
					<UserList
						v-if="!showChatPanel"
						:users="Array.from(store.state.users.users.values())"
					/>
					<ShareInvite />
				</div>
			</div>
		</div>
		<footer class="border-t px-4 py-6 text-center" v-if="!store.state.fullscreen">
			<p class="label-mono text-muted-foreground" v-if="isOfficialSite()">
				<router-link to="/privacypolicy">{{ $t("footer.privacy-policy") }}</router-link>
			</p>
			<p class="mt-2 font-mono text-xs text-dim">{{ gitCommit }}</p>
		</footer>
		<Transition name="ott-overlay">
			<div
				v-if="showDisconnectedOverlay"
				class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
			>
				<RoomDisconnected />
			</div>
		</Transition>
		<ServerMessageHandler />
		<WorkaroundPlaybackStatusUpdater />
		<WorkaroundUserStateNotifier />
		<template #player>
			<VideoControls
				v-if="!showDisconnectedOverlay"
				:slider-position="sliderPosition"
				:true-position="truePosition"
			/>
		</template>
	</RoomPlayerLayout>
</template>

<script lang="ts">
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import {
	Tabs,
	TabsContentAnimated,
	TabsContentAnimatedGroup,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	mdiPlay,
	mdiFormatListBulleted,
	mdiPlus,
	mdiWrench,
	mdiEarth,
	mdiEyeOff,
	mdiLock,
	mdiCircle,
	mdiPictureInPictureBottomRight,
} from "@mdi/js";
import {
	defineComponent,
	ref,
	type Ref,
	unref,
	computed,
	watch,
	onMounted,
	onUnmounted,
	nextTick,
	provide,
} from "vue";
import AddPreview from "@/components/AddPreview.vue";
import { calculateCurrentPosition } from "ott-common/timestamp";
import _ from "lodash";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import Chat from "@/components/Chat.vue";
import ChatPlacementToggle from "@/components/ChatPlacementToggle.vue";
import ResizeHandle from "@/components/ResizeHandle.vue";
import RoomSidePanel, { type RoomSidePanelTab } from "@/components/RoomSidePanel.vue";
import UserList from "@/components/UserList.vue";
import VideoQueue from "@/components/VideoQueue.vue";
import RoomSettingsForm from "@/components/RoomSettingsForm.vue";
import ShareInvite from "@/components/ShareInvite.vue";
import ClientSettingsDialog from "@/components/ClientSettingsDialog.vue";
import RoomDisconnected from "../components/RoomDisconnected.vue";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import ServerMessageHandler from "@/components/ServerMessageHandler.vue";
import WorkaroundPlaybackStatusUpdater from "@/components/WorkaroundPlaybackStatusUpdater.vue";
import WorkaroundUserStateNotifier from "@/components/WorkaroundUserStateNotifier.vue";
import { useStore } from "@/store";
import { useI18n } from "vue-i18n";
import { useRouter, useRoute } from "vue-router";
import type { ServerMessageSync } from "ott-common/models/messages";
import { useScreenOrientation } from "@vueuse/core";
import { KeyboardShortcuts, RoomKeyboardShortcutsKey } from "@/util/keyboard-shortcuts";
import VideoControls from "@/components/controls/VideoControls.vue";
import RestoreQueue from "@/components/RestoreQueue.vue";
import RoomPlayerLayout from "@/components/RoomPlayerLayout.vue";
import { waitForToken } from "@/util/token";
import { useSfx } from "@/plugins/sfx";
import { secondsToTimestamp } from "@/util/timestamp";
import { useCaptions, useMediaPlayer, useVolume } from "@/components/composables";
import { useGrants } from "@/components/composables/grants";
import { isOfficialSite } from "@/util/misc";
import { Visibility } from "ott-common/models/types";
import { ChatPlacement, DEFAULT_CHAT_PANEL_WIDTH } from "@/stores/settings";

const QUEUE_TABS = ["queue", "add", "settings"] as const;
const CHAT_PANEL_MIN_WIDTH = 280;

type QueueTab = (typeof QUEUE_TABS)[number];

// biome-ignore lint/style/noVueOptionsApi: TODO: convert to setup
export default defineComponent({
	name: "room",
	components: {
		VideoControls,
		VideoQueue,
		OmniPlayer,
		Chat,
		ChatPlacementToggle,
		ResizeHandle,
		RoomSidePanel,
		AddPreview,
		UserList,
		RoomSettingsForm,
		ShareInvite,
		ClientSettingsDialog,
		RoomDisconnected,
		ServerMessageHandler,
		WorkaroundPlaybackStatusUpdater,
		WorkaroundUserStateNotifier,
		RestoreQueue,
		RoomPlayerLayout,
		Badge,
		Button,
		Card,
		CardHeader,
		CardTitle,
		CardContent,
		Icon,
		Tabs,
		TabsContentAnimated,
		TabsContentAnimatedGroup,
		TabsList,
		TabsTrigger,
		Tooltip,
		TooltipContent,
		TooltipTrigger,
	},
	setup() {
		const store = useStore();
		const connection = useConnection();
		const roomapi = useRoomApi(connection);
		const { t } = useI18n();
		const router = useRouter();
		const route = useRoute();

		// actively calculate the current position of the video
		const truePosition = ref(0);
		const sliderPosition = ref(0);
		const iTimestampUpdater: Ref<ReturnType<typeof setInterval> | null> = ref(null);

		function timestampUpdate() {
			if (!store.state.room.currentSource) {
				truePosition.value = 0;
				sliderPosition.value = 0;
				return;
			}
			truePosition.value = store.state.room.isPlaying
				? calculateCurrentPosition(
						store.state.room.playbackStartTime,
						new Date(),
						store.state.room.playbackPosition,
						store.state.room.playbackSpeed,
				  )
				: store.state.room.playbackPosition;
			sliderPosition.value = _.clamp(
				truePosition.value,
				0,
				store.state.room.currentSource?.length ?? 0,
			);
		}

		onMounted(() => {
			iTimestampUpdater.value = setInterval(timestampUpdate, 250);
		});

		onUnmounted(() => {
			if (iTimestampUpdater.value) {
				clearInterval(iTimestampUpdater.value);
			}
		});

		watch(truePosition, async newPosition => {
			if (!player.isPlayerPresent()) {
				return;
			}
			const currentTime = player.getPosition();

			const diff = Math.abs(newPosition - (await currentTime));
			if (isNaN(diff)) {
				console.error("player diff is NaN, this is a bug", newPosition, currentTime);
				return;
			}
			if (diff > 1 && !mediaPlaybackBlocked.value) {
				player.setPosition(newPosition);
			}
		});

		// connection status
		const isConnected = computed(() => connection.connected);
		const connectionStatus = computed(() => {
			return connection.connected.value
				? t("room.con-status.connected")
				: t("room.con-status.connecting");
		});
		const connectionStatusColor = computed(() =>
			connection.connected.value ? "success" : "warning",
		);
		const showDisconnectedOverlay = computed(() => !!connection.kickReason.value);

		function rewriteUrlToRoomName() {
			if (store.state.room.name.length === 0) {
				return;
			}
			if (route.params.roomId !== store.state.room.name) {
				console.debug(
					`room name does not match URL, rewriting to "${store.state.room.name}"`,
				);
				router.replace({
					name: "room",
					params: { roomId: store.state.room.name },
				});
			}
		}

		async function waitForPlayer() {
			if (!player.isPlayerPresent()) {
				console.debug("waiting for player", player);
				await new Promise(resolve => {
					const stop = watch(player.player, async newPlayer => {
						if (newPlayer) {
							stop();
							resolve(true);
						}
					});
					// const interval = setInterval(() => {
					// 	if (player.isPlayerPresent()) {
					// 		clearInterval(interval);
					// 		resolve(true);
					// 	}
					// }, 100);
				});
			}
			if (!player.isPlayerPresent()) {
				return Promise.reject("Can't wait for player api ready: player not present");
			}
			if (player.apiReady.value) {
				return;
			}
			console.debug("detected player, waiting for api ready");
			await new Promise(resolve => {
				// const stop = watch(player.apiReady, async newReady => {
				// 	if (newReady) {
				// 		stop();
				// 		resolve(true);
				// 	}
				// });
				const interval = setInterval(() => {
					if (player.apiReady.value) {
						clearInterval(interval);
						resolve(true);
					}
				}, 100);
			});
		}

		async function onSyncMsg(msg: ServerMessageSync) {
			rewriteUrlToRoomName();
			if (msg.isPlaying !== undefined && !mediaPlaybackBlocked.value) {
				await applyIsPlaying(msg.isPlaying);
			}
		}

		function onRoomCreated() {
			if (connection.active.value) {
				connection.disconnect();
			}
			setTimeout(() => {
				if (!connection.active.value) {
					connection.connect(route.params.roomId as string);
				}
			}, 100);
		}

		let roomCreatedUnsub: (() => void) | null = null;
		onMounted(async () => {
			await waitForToken(store);

			connection.addMessageHandler("sync", onSyncMsg);
			if (!connection.active.value) {
				connection.connect(route.params.roomId as string);
			}

			roomCreatedUnsub = store.subscribe(mutation => {
				if (mutation.type === "misc/ROOM_CREATED") {
					onRoomCreated();
				}
			});
		});

		onUnmounted(() => {
			connection.removeMessageHandler("sync", onSyncMsg);
			connection.disconnect();

			if (roomCreatedUnsub) {
				roomCreatedUnsub();
			}
		});

		// player management
		const player = useMediaPlayer();
		const volume = useVolume();

		function togglePlayback() {
			if (store.state.room.isPlaying) {
				roomapi.pause();
			} else {
				roomapi.play();
			}
		}

		function seekDelta(delta: number) {
			roomapi.seek(
				_.clamp(truePosition.value + delta, 0, store.state.room.currentSource?.length ?? 0),
			);
		}

		// Indicates that starting playback is blocked by the browser. This usually means that the user needs
		// to interact with the page before playback can start. This is because browsers block autoplaying videos.
		const mediaPlaybackBlocked = ref(false);

		async function applyIsPlaying(playing: boolean): Promise<void> {
			await waitForPlayer();
			if (!player.isPlayerPresent()) {
				return Promise.reject("Can't apply IsPlaying: player not present");
			}
			try {
				if (playing) {
					await player.play();
				} else {
					await player.pause();
				}
				mediaPlaybackBlocked.value = false;
				return;
			} catch (e) {
				if (e instanceof DOMException && e.name === "NotAllowedError") {
					mediaPlaybackBlocked.value = true;
				} else {
					console.error("Can't apply IsPlaying: ", e.name, e);
				}
			}
		}

		function onClickUnblockPlayback(): void {
			player?.setPosition(truePosition.value);
			applyIsPlaying(store.state.room.isPlaying);
		}

		function onPlayerApiReady() {
			console.debug("internal player API is now ready");
		}

		async function onPlaybackChange(changeTo: boolean) {
			console.debug(`onPlaybackChange: ${changeTo}`);
			if (changeTo === store.state.room.isPlaying) {
				return;
			}

			await applyIsPlaying(store.state.room.isPlaying);
		}
		function onPlayerReady() {
			if (
				currentSource.value?.service === "vimeo" ||
				currentSource.value?.service === "youtube"
			) {
				onPlayerReadyApplyRoomState();
			}
		}
		// Iframe-based players can (re)enter the ready state without having the room's current
		// position/play state applied yet (e.g. YouTube's native-controls toggle remounts the
		// player, landing it cued at position 0). Re-apply both here rather than waiting for the
		// timestamp watcher, which never fires while the room is paused.
		async function onPlayerReadyApplyRoomState() {
			player?.setPosition(truePosition.value);
			await applyIsPlaying(store.state.room.isPlaying);
		}

		const captions = useCaptions();
		function isCaptionsSupported() {
			return captions.isCaptionsSupported.value;
		}
		function getCaptionsTracks() {
			return captions.captionsTracks.value;
		}

		// misc UI stuff
		const isMobile = computed(
			() => window.matchMedia("only screen and (max-width: 760px)").matches,
		);
		const orientation = useScreenOrientation();
		const queueTab = ref<QueueTab>("queue");
		const roomSettingsForm = ref<typeof RoomSettingsForm | null>(null);

		onMounted(() => {
			if (!orientation.isSupported.value) {
				return;
			}

			watch(orientation.orientation, async newOrientation => {
				if (!newOrientation) {
					return;
				}
				if (isMobile.value) {
					if (newOrientation.startsWith("landscape")) {
						// this promise is rejected if the fullscreen request is denied
						await document.documentElement.requestFullscreen();
						window.scrollTo({ top: 0, behavior: "smooth" });
					} else {
						document.exitFullscreen();
					}
				}
			});
		});

		watch(queueTab, async newTab => {
			if (roomSettingsForm.value && newTab === "settings") {
				await roomSettingsForm.value.loadRoomSettings();
			}
		});

		const granted = useGrants();

		const addpreview = ref<typeof AddPreview | null>(null);
		async function setAddPreviewText(text: string) {
			queueTab.value = "add";
			await nextTick();
			if (!addpreview.value) {
				// HACK: the tab is not yet mounted, so we need to wait for it to be mounted
				// this will be more elegant when we have a new vue 3 style global event bus.
				await nextTick();
			}
			if (addpreview.value) {
				addpreview.value.setAddPreviewText(text);
			} else {
				console.error("addpreview is not mounted, can't set text");
			}
		}

		// keyboard shortcuts
		const shortcuts = new KeyboardShortcuts();
		shortcuts.bind([{ code: "Space" }, { code: "KeyK" }], () => {
			if (granted("playback.play-pause")) {
				togglePlayback();
			}
		});
		shortcuts.bind(
			[{ code: "ArrowLeft" }, { code: "ArrowRight" }, { code: "KeyJ" }, { code: "KeyL" }],
			(e: KeyboardEvent) => {
				if (granted("playback.seek")) {
					let seekIncrement = 5;
					if (e.ctrlKey || e.code === "KeyJ" || e.code === "KeyL") {
						seekIncrement = 10;
					}
					if (e.code === "ArrowLeft" || e.code === "KeyJ") {
						seekIncrement *= -1;
					}

					seekDelta(seekIncrement);
				}
			},
		);
		shortcuts.bind({ code: "Home" }, () => {
			if (granted("playback.seek")) {
				roomapi.seek(0);
			}
		});
		shortcuts.bind({ code: "End" }, () => {
			if (granted("playback.skip")) {
				roomapi.skip();
			}
		});
		shortcuts.bind([{ code: "ArrowUp" }, { code: "ArrowDown" }], (e: KeyboardEvent) => {
			volume.volume.value = _.clamp(
				volume.volume.value + 5 * (e.code === "ArrowDown" ? -1 : 1),
				0,
				100,
			);
		});
		shortcuts.bind({ code: "F12", ctrlKey: true, shiftKey: true }, () => {
			debugMode.value = !debugMode.value;
		});
		function onKeyDown(e: KeyboardEvent) {
			// Focused widgets own Space and arrow keys; do not issue a second command.
			if (
				e.defaultPrevented ||
				(e.target instanceof Element &&
					e.target.closest(
						'button, a, input, textarea, select, [role="slider"], [role="tab"], [role="menuitem"], [contenteditable="true"]',
					))
			) {
				return;
			}
			shortcuts.handleKeyDown(e);
		}
		provide(RoomKeyboardShortcutsKey, shortcuts);

		onMounted(() => {
			window.addEventListener("keydown", onKeyDown);
		});

		onUnmounted(() => {
			window.removeEventListener("keydown", onKeyDown);
		});

		const roomVisibility = computed(() => store.state.room.visibility);

		const roomVisibilityIcon = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return mdiEarth;
				case Visibility.Unlisted:
					return mdiEyeOff;
				case Visibility.Private:
					return mdiLock;
				default:
					return mdiEyeOff;
			}
		});

		const roomVisibilityLabel = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return t("room-settings.public");
				case Visibility.Unlisted:
					return t("room-settings.unlisted");
				case Visibility.Private:
					return t("room-settings.private");
				default:
					return "This is a bug";
			}
		});

		async function onVisibilityClick() {
			queueTab.value = "settings";
			await nextTick();
			if (roomSettingsForm.value) {
				await roomSettingsForm.value.loadRoomSettings();
				await nextTick();
				roomSettingsForm.value.openVisibilityMenu();
				roomSettingsForm.value.$el?.scrollIntoView({ behavior: "smooth" });
			}
		}

		// chat placement
		// YouTube's terms don't allow drawing anything over its player, so chat can't go in-video there.
		const inVideoChatAllowed = computed(() => currentSource.value?.service !== "youtube");
		const chatPlacement = computed(() =>
			inVideoChatAllowed.value ? store.state.settings.chatPlacement : ChatPlacement.panel,
		);
		const showChatPanel = computed(
			() => !store.state.fullscreen && chatPlacement.value === ChatPlacement.panel,
		);
		const showInVideoChat = computed(
			() =>
				inVideoChatAllowed.value &&
				(store.state.fullscreen || chatPlacement.value === ChatPlacement.video),
		);
		const chatPanelWidth = computed({
			get: () => store.state.settings.chatPanelWidth,
			set: chatPanelWidth => store.commit("settings/UPDATE", { chatPanelWidth }),
		});
		const sidePanelTab = ref<RoomSidePanelTab>("chat");
		// Chat remounts when it moves between the panel and the video, so the room owns this
		// shortcut instead of each Chat instance.
		const chat = ref<InstanceType<typeof Chat> | null>(null);
		shortcuts.bind({ code: "KeyT" }, () => {
			sidePanelTab.value = "chat";
			chat.value?.activate();
		});
		function moveChatIntoVideo() {
			store.commit("settings/UPDATE", { chatPlacement: ChatPlacement.video });
		}

		// small helper aliases
		const currentSource = computed(() => store.state.room.currentSource);
		const production = computed(() => store.state.production);

		// debug mode
		const debugMode = ref(!unref(production));
		provide("debugMode", debugMode);

		const sfx = useSfx();
		onMounted(async () => {
			await sfx.loadSfx();
		});

		const gitCommit = __COMMIT_HASH__;

		return {
			store,
			roomapi,
			granted,
			isOfficialSite,

			truePosition,
			sliderPosition,

			isConnected,
			connectionStatus,
			connectionStatusColor,
			showDisconnectedOverlay,

			player,
			volume,
			togglePlayback,
			onPlayerApiReady,
			onPlayerReady,
			onPlaybackChange,
			isCaptionsSupported,
			getCaptionsTracks,

			isMobile,
			queueTab,
			settings: roomSettingsForm,
			addpreview,
			setAddPreviewText,

			currentSource,
			production,
			debugMode,
			orientation: orientation.orientation,
			gitCommit,

			mediaPlaybackBlocked,
			onClickUnblockPlayback,
			secondsToTimestamp,

			roomVisibilityIcon,
			roomVisibilityLabel,

			inVideoChatAllowed,
			showChatPanel,
			showInVideoChat,
			chatPanelWidth,
			sidePanelTab,
			chat,
			moveChatIntoVideo,
			CHAT_PANEL_MIN_WIDTH,
			DEFAULT_CHAT_PANEL_WIDTH,
			onVisibilityClick,

			// MDI Icons
			mdiPlay,
			mdiFormatListBulleted,
			mdiPlus,
			mdiWrench,
			mdiCircle,
			mdiPictureInPictureBottomRight,
		};
	},
});
</script>

<style scoped>
.room-media-grid {
	display: grid;
	width: 100%;
	min-width: 0;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-rows: minmax(400px, 70vh);
}
.room-content[data-layout="theater"] .room-media-grid {
	grid-template-rows: minmax(400px, 85vh);
}
@media (max-width: 1023px) {
	/* Keep a real source surface, including YouTube's 200px minimum height. */
	.room-media-grid,
	.room-content[data-layout="theater"] .room-media-grid {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: max(200px, min(50dvh, 56.25vw)) auto;
	}
}
.room-content[data-fullscreen="true"] .room-media-grid {
	height: calc(var(--room-viewport-height, 100dvh) - var(--room-player-height, 160px));
	grid-template-columns: minmax(0, 1fr);
	grid-template-rows: minmax(0, 1fr);
}
</style>
