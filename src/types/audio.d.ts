type AudioFormats = "mp3" | "wav";

interface playlistResponse extends ytpl.result {
  thumbnail: {
    url: string,
    width: number,
    height: number
  },
  items: {
    url: string,
    title: string,
    description: string | null,
    thumbnail: {
      url: string,
      width: number,
      height: number
    }
  }[]
}