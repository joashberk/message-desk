# Message Desk

SENT Life Center's tool for uploading, trimming and publishing recorded messages to sentlifecenter.com.

**Setting it up or changing a key?** Follow [docs/SETUP.md](docs/SETUP.md).

## How it fits together

| Part | What it does | Where it runs | Cost |
|---|---|---|---|
| The app (`public/`) | The screens the team uses | Vercel (Hobby) | Free |
| The server (`api/`, `lib/`) | Sign-in, Drive filing, Webflow drafts and publishing | Vercel (one function) | Free |
| Storage | Originals, final edits, previews and the app's saved state | Google Drive of sentlifecenter.tech@gmail.com | Uses Drive space |
| Preview job (`worker/prepare.js`) | Lightweight preview copy and timeline thumbnails after each upload | GitHub Actions | Free* |
| Render job (`worker/render.js`) | Frame-accurate cut, H.264 compression, Vimeo upload, MP3, Drive | GitHub Actions | Free* |
| Weekly tidy-up (`worker/cleanup.js`) | Trashes previews of messages live for 30+ days | GitHub Actions | Free |

\*Private repositories get 2,000 free GitHub Actions minutes a month; public ones have no limit.

### Drive filing

`01_SLC Media Library > [year] > [collection folder] > ##_[CODE]_YYYY_MM_DD > Original + Final edit`

| Collection | Folder | Code | Website collection |
|---|---|---|---|
| Sunday | `01_SLC_Sundays_[year]` | `Sunday` | Sunday Messages |
| Hebron | `03_HEBRON` | `HEBRON` | Hebron Messages |
| Charis | `04_Charis/X-Elle` | `CX` | Charis Messages |

`##` is the next number after the highest one already in the collection folder. Files are named after the meeting
(`Hebron_2026_11_07.mov` in Original, `.mp4` and `.mp3` in Final edit); a second recording on the same date goes in the
same folder as `_Part2`. Notes files keep their own names. Work in progress lives in **Message Desk working files** in the
root of the same Drive.

## For developers

```bash
npm run dev      # http://localhost:3000 with pretend Drive/Webflow/render when no Google keys are set
npm test         # naming rules, Drive filing, and frame-accurate cuts with real ffmpeg
```
