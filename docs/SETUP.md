# Setting up Message Desk

Do these in order. Each key is pasted into a settings page, never into code, chat or email.

## Where each key goes

| Key name | What it is | Vercel | GitHub Actions |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Identifies Message Desk to Google | Yes | Yes |
| `GOOGLE_CLIENT_SECRET` | Google's password for Message Desk | Yes | Yes |
| `GOOGLE_REFRESH_TOKEN` | Lets Message Desk use the sentlifecenter.tech Drive | Yes | Yes |
| `ALLOWED_EMAILS` | Team members who can sign in, separated by commas | Yes | No |
| `WEBFLOW_TOKEN` | Lets Message Desk add and publish website items | Yes | No |
| `VIMEO_TOKEN` | Lets Message Desk upload to Vimeo | Yes | Yes |
| `GH_DISPATCH_TOKEN` | Lets Message Desk start render jobs on GitHub | Yes | No |
| `ZOOM_WEBHOOK_SECRET` | Proves calls about new recordings really come from Zoom | Yes | No |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Lets the import job copy cloud recordings | No | Yes |

After changing anything in Vercel, redeploy (Deployments, the latest one, the "..." menu, Redeploy).

## 1. Put the app on Vercel

1. Go to vercel.com and sign in with GitHub.
2. Add New, Project, then Import next to **message-desk**.
3. Leave every setting as it is and click Deploy.
4. Copy the web address it gives you (like `message-desk-abc.vercel.app`). You need it in step 2.

## 2. Google (signed in as sentlifecenter.tech@gmail.com)

1. Go to console.cloud.google.com. Create a project called **Message Desk**.
2. Search for **Google Drive API** and click Enable.
3. Open **Google Auth Platform** (it may be called OAuth consent screen). Click Get started.
   App name: Message Desk. Support email: sentlifecenter.tech@gmail.com. Audience: External. Finish.
4. In **Audience**, click **Publish app**. This keeps the Drive connection from expiring every 7 days.
5. In **Clients**, Create client. Type: Web application. Name: Message Desk.
   - Authorized JavaScript origins: `https://YOUR-VERCEL-ADDRESS`
   - Authorized redirect URIs: `https://YOUR-VERCEL-ADDRESS/api/google/callback`
6. Create. Copy the **Client ID** and **Client secret**.

## 3. Vercel settings

Vercel, the message-desk project, Settings, Environment Variables. Add each of these (all environments), then redeploy:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from step 2
- `ALLOWED_EMAILS`, for example `joash@eido.net, volunteer@gmail.com`

## 4. Connect Drive (one time)

1. Open the Vercel address and sign in with your own Google account (it must be in `ALLOWED_EMAILS`).
2. Go to `https://YOUR-VERCEL-ADDRESS/api/google/connect`.
3. Choose **sentlifecenter.tech@gmail.com**. Google warns the app isn't verified: click Advanced, then Go to Message Desk.
   This is expected for a private tool. Allow access to Drive.
4. Message Desk shows a key once. Copy it and add it in Vercel as `GOOGLE_REFRESH_TOKEN`, then redeploy.
   If you signed in with any other account, nothing is saved and it asks you to try again.

## 5. Webflow

Webflow, SENT Website 2024, Site settings, Apps & integrations, API access, Generate API token.
Name it Message Desk and turn on: **CMS: read and write**, **Assets: read and write**, **Sites: read**.
Add it in Vercel as `WEBFLOW_TOKEN`.

## 6. Vimeo

developer.vimeo.com, My Apps, Create an app (name: Message Desk, only you will use it).
In the app, Generate an access token: Authenticated (you), with **Public, Private, Edit, Upload**.
Add it in Vercel and in GitHub (step 8) as `VIMEO_TOKEN`.

## 7. GitHub key for starting renders

github.com, your picture, Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.
Name: Message Desk. Repository access: Only select repositories, **message-desk**. Permissions: **Actions: Read and write**.
Expiration: the longest offered (set a reminder to renew it). Add it in Vercel as `GH_DISPATCH_TOKEN`.

## 8. GitHub Actions secrets

github.com/joashberk/message-desk, Settings, Secrets and variables, Actions, New repository secret. Add:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `VIMEO_TOKEN`.

## 9. Zoom cloud recordings (optional)

Meetings recorded to the Zoom cloud become drafts automatically when their name includes **Hebron**,
**Charis**, **X-Elle**, **CX** or **Sunday** and they're at least 5 minutes long. After the copy in Drive is
confirmed, the Zoom recording moves to Zoom's trash (recoverable there for 30 days).

1. marketplace.zoom.us, signed in as sentlifecenter.tech@gmail.com. Develop, Build App, **Server to Server OAuth App**. Name: Message Desk.
2. **App Credentials:** copy Account ID, Client ID and Client Secret into GitHub secrets
   `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.
3. **Information:** fill in the short description and the developer name and email.
4. **Feature:** copy the **Secret Token** into Vercel as `ZOOM_WEBHOOK_SECRET` and redeploy. Then turn on
   Event Subscriptions, Add New Event Subscription, endpoint URL `https://YOUR-VERCEL-ADDRESS/api/zoom/webhook`,
   Add Events, Recording, **All Recordings have completed**. Click Validate, then Save.
5. **Scopes:** add the cloud recording scopes to view recordings and recording files, and to delete meeting recordings.
6. **Activation:** Activate your app.
7. To test: GitHub, Actions, Import Zoom recording, Run workflow, type `check`. Its log lists last week's
   recordings and what would happen to each.

## Keeping it running

- Renew the GitHub key before it expires (step 7).
- If Message Desk says it lost its Drive connection, repeat step 4 and replace `GOOGLE_REFRESH_TOKEN` in both places.
- To add or remove a team member, edit `ALLOWED_EMAILS` in Vercel and redeploy.
