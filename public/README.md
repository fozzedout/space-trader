# Dev Testing Interface

## Quick Start

### Option 1: Direct File Access (Recommended)

Simply open `dev.html` in your browser:
```bash
# From the project root
open public/dev.html
# or
xdg-open public/dev.html  # Linux
```

Make sure your dev server is running (`npm run dev`) on `http://localhost:3000`.

### Option 2: Simple HTTP Server

```bash
cd public
python3 -m http.server 8000
# Then open http://localhost:8000/dev.html
```

## Features

- **Galaxy Operations**: Initialize galaxy, tick all systems, health check
- **System Operations**: Get snapshots, state, tick individual systems, compare systems
- **Ship Operations**: Get ship state, tick ships, list multiple ships
- **Quick Tests**: Automated test suite, price comparisons, market analysis

## Usage

1. Start your dev server: `npm run dev`
2. Open `dev.html` in your browser
3. Click buttons to test endpoints
4. View results in the results panel

## Notes

- All API calls go to `window.location.origin` (your dev server)
- Results are logged with timestamps
- Errors are highlighted in red
- Success messages are in green
