# Dev Frontend Testing Interface

A simple, functional HTML interface for testing all API endpoints during development.

## Quick Start

### Method 1: Direct File Access (Easiest)

1. Start your dev server:
   ```bash
   npm run dev
   ```

2. Open `public/dev.html` directly in your browser:
   ```bash
   # Linux
   xdg-open public/dev.html
   
   # macOS
   open public/dev.html
   
   # Windows
   start public/dev.html
   ```

The interface will automatically connect to your dev server at `http://localhost:3000`.

### Method 2: Simple HTTP Server

```bash
cd public
python3 -m http.server 8000
# Then open http://localhost:8000/dev.html
```

## Features

### 🌌 Galaxy Operations
- **Initialize Galaxy**: Create 256 systems + NPCs
- **Tick All Systems**: Process ticks for entire galaxy
- **Health Check**: Verify API is responding

### ⭐ System Operations
- **Get Snapshot**: Full system state with markets
- **Get State**: Basic system information
- **Tick System**: Process simulation tick
- **Compare Systems**: Side-by-side comparison (systems 0-5)

### 🛸 Ship Operations
- **Get State**: Ship location, cargo, credits
- **Tick Ship**: Process ship actions
- **List Ships**: View multiple ships (npc-0 to npc-9)

### 💰 Experimental Trading
- Test trades without affecting simulation
- Buy/sell any good in any system
- See price calculations

### 📊 Quick Tests
- **Quick Test Suite**: Automated end-to-end test
- **Price Comparison**: Compare prices across systems 0-9
- **Market Analysis**: Detailed market breakdown for a system

## Usage

1. **Start Dev Server**: `npm run dev` (must be running)
2. **Open Interface**: Open `public/dev.html` in browser
3. **Test Endpoints**: Click buttons to test different operations
4. **View Results**: See all responses in the results panel

## Interface Layout

- **Dark theme** for easy reading
- **Color-coded results**: Green (success), Red (error), Blue (info)
- **Timestamped logs**: Every action is logged with timestamp
- **Scrollable results**: Results panel scrolls automatically

## API Endpoints Tested

All endpoints are tested:
- `POST /api/galaxy/initialize`
- `POST /api/galaxy/tick`
- `GET /api/health`
- `GET /api/system/{id}?action=snapshot`
- `GET /api/system/{id}?action=state`
- `POST /api/system/{id}?action=tick`
- `GET /api/ship/{shipId}`
- `POST /api/ship/{shipId}`
- `POST /api/experimental/trade`

## Tips

- **Clear Results**: Results accumulate - refresh page to clear
- **Quick Test**: Use "Run Quick Test Suite" for full workflow test
- **Compare Systems**: Use "Compare Systems" to find arbitrage opportunities
- **Market Analysis**: Use "Market Analysis" to see supply/demand ratios

## Troubleshooting

### CORS Errors
- Make sure dev server is running
- Check that API base URL matches your dev server

### 404 Errors
- Verify dev server is running on correct port
- Check that endpoints match your API routes

### Empty Results
- Make sure you've initialized the galaxy first
- Check browser console for JavaScript errors

## Notes

- This is a **development-only** interface
- Not meant for production use
- Simple HTML/JS - no build step required
- All API calls use `fetch()` with proper error handling
