import { getKuGouPlaylistTracks, getKuGouUserPlaylists, scoreKuGouSongMatch, searchKuGouSong } from "./kugou.js";
import { getKuGouLibraryStatus, replaceKuGouLibrary } from "./db.js";
import { toKuGouApiTrack } from "./kugou-catalog.js";
import type { Track } from "./types.js";

export async function findExactKuGouApiTrack(input: Pick<Track, "artist" | "title">) {
  const songs = await searchKuGouSong(`${input.artist} ${input.title}`, 8);
  const match = songs
    .map((song) => ({ song, score: scoreKuGouSongMatch(input, song) }))
    .sort((left, right) => right.score - left.score)[0];
  return match?.score === 100 ? toKuGouApiTrack(match.song) : undefined;
}

export async function syncKuGouLibrary() {
  const remotePlaylists = await getKuGouUserPlaylists();
  const tracks = new Map<string, Track>();
  const playlists = [];

  for (const playlist of remotePlaylists) {
    const songs = await getKuGouPlaylistTracks(playlist.id, playlist.trackCount);
    const trackIds = [...new Set(songs.map((song) => {
      const track = toKuGouApiTrack(song);
      tracks.set(track.id, track);
      return track.id;
    }))];
    playlists.push({ id: playlist.id, name: playlist.name, trackCount: trackIds.length, trackIds });
  }

  const change = replaceKuGouLibrary({ playlists, tracks: [...tracks.values()] });
  return { ...getKuGouLibraryStatus(), ...change };
}

export { getKuGouLibraryStatus };
export { toKuGouApiTrack } from "./kugou-catalog.js";
