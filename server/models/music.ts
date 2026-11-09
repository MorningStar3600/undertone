import { DataTypes, Model, type Sequelize, type ModelStatic } from "sequelize";
import type {
	Track,
	TrackSource,
	Mood,
	UserLibraryTrack,
	UserTrackMood,
	UserFavoriteMood,
} from "ott-common/models/music.js";

export type MusicRow<T extends object> = Model<T> & {
	readonly createdAt: Date;
	readonly updatedAt: Date;
};
type StoredMood = Mood & { createdBy: number | null };

export interface MusicModels {
	Track: ModelStatic<MusicRow<Track>>;
	TrackSource: ModelStatic<MusicRow<TrackSource>>;
	Mood: ModelStatic<MusicRow<StoredMood>>;
	UserLibraryTrack: ModelStatic<MusicRow<UserLibraryTrack>>;
	UserTrackMood: ModelStatic<MusicRow<UserTrackMood>>;
	UserFavoriteMood: ModelStatic<MusicRow<UserFavoriteMood>>;
}

export function createMusicModels(sequelize: Sequelize): MusicModels {
	const uuid = () => ({ type: DataTypes.UUID, primaryKey: true, allowNull: false });
	const trackKey = () => ({
		type: DataTypes.UUID,
		primaryKey: true,
		allowNull: false,
		references: { model: "Tracks", key: "id" },
		onDelete: "CASCADE",
	});
	const userKey = () => ({
		type: DataTypes.INTEGER,
		primaryKey: true,
		allowNull: false,
		references: { model: "Users", key: "id" },
		onDelete: "CASCADE",
	});
	const moodKey = () => ({
		type: DataTypes.UUID,
		primaryKey: true,
		allowNull: false,
		references: { model: "Moods", key: "id" },
		onDelete: "CASCADE",
	});
	const Track = sequelize.define<MusicRow<Track>>("Track", {
		id: uuid(),
		title: { type: DataTypes.STRING(512), allowNull: false },
		artists: { type: DataTypes.JSON, allowNull: false },
		styles: { type: DataTypes.JSON, allowNull: false },
		duration: { type: DataTypes.DOUBLE, allowNull: true },
		artworkUrl: { type: DataTypes.TEXT, allowNull: true },
	});
	const TrackSource = sequelize.define<MusicRow<TrackSource>>(
		"TrackSource",
		{
			id: uuid(),
			trackId: { ...trackKey(), primaryKey: false },
			service: { type: DataTypes.STRING(32), allowNull: false },
			providerId: { type: DataTypes.STRING(2048), allowNull: false },
			capabilities: { type: DataTypes.JSON, allowNull: false },
			availability: { type: DataTypes.STRING(16), allowNull: false },
		},
		{
			indexes: [
				{ name: "track_source_provider", unique: true, fields: ["service", "providerId"] },
				{ name: "track_source_track", fields: ["trackId"] },
			],
		},
	);
	const Mood = sequelize.define<MusicRow<StoredMood>>("Mood", {
		id: uuid(),
		name: { type: DataTypes.STRING(64), allowNull: false },
		normalizedName: { type: DataTypes.STRING(64), allowNull: false, unique: true },
		iconKey: { type: DataTypes.STRING(32), allowNull: false },
		createdBy: {
			type: DataTypes.INTEGER,
			allowNull: true,
			references: { model: "Users", key: "id" },
			onDelete: "SET NULL",
		},
	});
	const UserLibraryTrack = sequelize.define<MusicRow<UserLibraryTrack>>("UserLibraryTrack", {
		userId: userKey(),
		trackId: trackKey(),
		importKind: { type: DataTypes.STRING(16), allowNull: false },
	});
	const UserTrackMood = sequelize.define<MusicRow<UserTrackMood>>(
		"UserTrackMood",
		{
			userId: userKey(),
			trackId: trackKey(),
			moodId: moodKey(),
		},
		{
			indexes: [
				{ name: "user_track_mood_user_mood", fields: ["userId", "moodId"] },
				{ name: "user_track_mood_track_user", fields: ["trackId", "userId"] },
			],
		},
	);
	const UserFavoriteMood = sequelize.define<MusicRow<UserFavoriteMood>>("UserFavoriteMood", {
		userId: userKey(),
		moodId: moodKey(),
	});
	return { Track, TrackSource, Mood, UserLibraryTrack, UserTrackMood, UserFavoriteMood };
}
