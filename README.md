# Classroom Web Analyzer

A web app that turns your Google Classroom workload into a priority-sorted weekly study plan, with an AI assistant for each assignment.

**Live:** https://classroom-web-analyzer.vercel.app

## What it does

- Signs in with Google and fetches your Classroom courses, assignments, announcements, and submissions.
- Sorts what's due into a "do now / this week" plan, with AI-estimated priority, effort, and a one-line summary per item.
- Per-assignment AI chat to help you plan or get unstuck.
- Pin, dismiss, and hide courses; preferences sync across devices.

## Stack

- **Frontend:** Vanilla JS single-page app (`index.html`, `app.js`, `styles.css`) — no framework, no build step.
- **Backend:** Vercel serverless functions in `api/` (auth, AI streaming, enrichment, prefs, chat history).
- **Auth:** Google OAuth (Classroom read-only scopes).

## Running locally

Requires the [Vercel CLI](https://vercel.com/docs/cli):

```bash
vercel dev
```

Set the required environment variables (Google OAuth client, AI API key, storage) in your Vercel project or a local `.env`.

## Deploy

Pushes to the default branch deploy automatically via Vercel.
