# Webscraping API Template

This project provides a simple Express server for building web scraping APIs using TypeScript. It includes helpers for working with Puppeteer or Playwright and a basic endpoint for fetching data from websites.

## Setup

1. Copy `.env-example` to `.env` and fill in any required values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Start the server:
   ```bash
   npm start
   ```

A `Dockerfile` and `docker-compose.yml` are included for containerized deployments.

## Endpoints

- `POST /api/fetch` – Fetches a web page using a site-specific handler or a proxy fallback.
- `GET /health` – Basic health check.

Customize handlers under `src/lib/sites` to implement scraping logic for different domains.
