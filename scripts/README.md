# Economy Analysis Scripts

Scripts for running long-term economy simulations and generating analysis reports using LM Studio.

## Quick Start

### Full Analysis (30 minutes)

```bash
npm run analyze:economy
```

This will:
1. Start the server (if not running)
2. **Reset the entire database** (clears all systems, ships, markets, players)
3. Initialize a fresh galaxy from scratch
4. Run simulation for 30 minutes, collecting data every 30 seconds
5. Analyze the data using LM Studio
6. Generate a report with recommendations

### Test Mode (5 minutes)

```bash
npm run test:economy
```

Runs the same pipeline but in test mode:
- Duration: 5 minutes (instead of 30)
- Collection interval: 10 seconds (instead of 30)
- Perfect for quick verification

**Note**: The reset ensures each analysis run starts from a completely clean state, eliminating any bias from previous simulations.

## Manual Usage

### Step 1: Start the server

```bash
npm run dev
```

### Step 2: Collect data (30 minutes)

```bash
tsx scripts/collect-economy-data.ts
```

Data will be saved to `economy-data/economy-data-<timestamp>.json`

### Step 3: Analyze with LM Studio

```bash
tsx scripts/analyze-with-llm.ts economy-data/economy-data-<timestamp>.json
```

Report will be saved to `economy-reports/economy-report-<timestamp>.md`

## Configuration

### Environment Variables

- `SERVER_URL`: Server URL (default: `http://localhost:3000`)
- `LM_STUDIO_URL`: LM Studio API URL (default: `http://localhost:1234/v1/chat/completions`)
- `LM_STUDIO_MODEL`: Model name (default: `local-model`)

### Script Parameters

The script automatically detects test mode via:
- `TEST_MODE=true` environment variable, or
- `--test` command line argument

In test mode:
- Duration: 5 minutes (vs 30 minutes)
- Collection interval: 10 seconds (vs 30 seconds)

To manually change parameters, edit `scripts/collect-economy-data.ts`:
- `DURATION_MINUTES`: How long to run (default: 30, test: 5)
- `COLLECTION_INTERVAL_SECONDS`: How often to collect data (default: 30, test: 10)

## LM Studio Setup

1. Install and run LM Studio
2. Load a model
3. Enable the Local Server (Settings → Local Server)
4. Default port is 1234

## Output

- **Data files**: `economy-data/economy-data-*.json` - Raw collected data
- **Reports**: `economy-reports/economy-report-*.md` - Analysis reports with recommendations
