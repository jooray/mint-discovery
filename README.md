# Cashu Mint Discovery

A portable JavaScript library for discovering Cashu mints via Nostr. Extracted from [cashu.me](https://cashu.me) for use in other projects.

<!-- jooray-links:start -->
### More from me

**Related projects**

- [cashupayserver](https://github.com/jooray/cashupayserver): BTCPay-compatible Lightning payments through Cashu, on ordinary PHP hosting
- [cashu-wallet-php](https://github.com/jooray/cashu-wallet-php): a Cashu wallet library in PHP
- [donation-sink](https://github.com/jooray/donation-sink): accept donations as Cashu tokens
- [btcpay-greenfield-test](https://github.com/jooray/btcpay-greenfield-test): a minimal page for testing BTCPay Greenfield API integrations

**Full project showcase:** Part of [CashuPayServer](https://juraj.bednar.io/showcase/#PAY-01) in my project showcase, or [all my projects](https://juraj.bednar.io/showcase/).

I write about building things on [my blog](https://juraj.bednar.io/en/blog-en/). I also wrote a cypherpunk novel, [Tamers of Entropy](https://tamersofentropy.net/), and there is a [trailer](https://tamersofentropy.net/#trailer).
<!-- jooray-links:end -->

## Features

- Fetches mint info events (kind 38172) from Nostr relays
- Fetches review events (kind 38000 with `#k=38172` tag)
- Parses review ratings in `[X/5] comment` format
- Fetches HTTP info from each mint's `/v1/info` endpoint
- Aggregates reviews and calculates average ratings
- Sorts mints: reachable first, then by a rating score that weighs the average by the number of ratings (see `compareRecommendations`)
- Optional IndexedDB caching with 1-hour refresh interval
- Works in both browser and Node.js environments

## Installation

### Copy files directly

Copy the `mint-discovery/` directory to your project.

### As npm package (local)

```bash
# From your project
npm install ./path/to/cashu.me/mint-discovery
```

### Dependencies

Requires `nostr-tools` (lightweight, works in browser + Node.js):

```bash
npm install nostr-tools
```

## Quick Start

### Browser

```html
<script type="module">
  import { MintDiscovery } from './mint-discovery/index.js';

  const discovery = MintDiscovery.create();
  const mints = await discovery.discover();

  console.log('Found mints:', mints.length);
  mints.forEach(mint => {
    console.log(`${mint.url}: ${mint.reviewsCount} reviews, avg ${mint.averageRating}`);
  });

  discovery.close();
</script>
```

### Node.js

```javascript
const { MintDiscovery } = require('./mint-discovery');

async function main() {
  const discovery = MintDiscovery.create({
    useStorage: false // IndexedDB not available in Node.js
  });

  const mints = await discovery.discover();
  console.log('Found mints:', mints.length);

  discovery.close();
}

main();
```

## API Reference

### `MintDiscovery.create(options)`

Create a new discovery instance.

**Options:**
- `relays` (string[]): Nostr relay URLs (default: see DEFAULT_RELAYS)
- `nostrTimeout` (number): Nostr query timeout in ms (default: 10000)
- `httpTimeout` (number): HTTP request timeout in ms (default: 10000)
- `httpConcurrency` (number): Max concurrent HTTP requests (default: 20)
- `httpDelayMs` (number): Delay between HTTP requests (default: 100)
- `httpBatchTimeout` (number): Deadline for all HTTP checks of one discovery run in ms (default: 60000)
- `cacheMaxAge` (number): Cache max age in seconds (default: 3600)
- `useStorage` (boolean): Enable IndexedDB storage (default: true in browser)

Only public `https://` mint URLs are listed (no IP addresses, `localhost` or `.local` names). Each Nostr event contributes at most 5 URLs, and one run lists and checks at most 300, preferring mints with an announcement or reviews from several people.

### Instance Methods

#### `discover(options)`

Fetch all mints and reviews from Nostr, then fetch HTTP info. This method waits for all Nostr events before returning.

```javascript
const mints = await discovery.discover({
  skipHttpFetch: false, // Set true to skip /v1/info fetching
  onProgress: ({ phase, step, url }) => console.log(phase, step)
});
```

Returns: `Promise<MintRecommendation[]>`

#### `discoverStreaming(callbacks)`

Discover mints with streaming updates as events arrive from Nostr. Unlike `discover()`, this emits mints progressively via callbacks, providing a better user experience as mints appear within 1-2 seconds instead of waiting for all data.

```javascript
const mints = await discovery.discoverStreaming({
  onMint: (mint) => {
    // Called for each new mint or when a mint's data is updated
    console.log('Mint:', mint.url, mint.reviewsCount, 'reviews');
    updateUI(mint);
  },
  onProgress: ({ phase, step }) => {
    // Progress phases: 'nostr' (step: 'subscribing', 'mint-info-complete', 'reviews-complete')
    //                  'http' (step: 'fetching', 'fetched')
    //                  'done'
    console.log('Progress:', phase, step);
  },
  onComplete: (allMints) => {
    // Called when initial discovery is complete
    console.log('Complete:', allMints.length, 'mints');
  }
});
```

**Callbacks:**
- `onMint(recommendation)`: Called whenever a mint is discovered or updated (new review, HTTP info fetched)
- `onProgress({ phase, step, url?, error? })`: Progress updates during discovery
- `onComplete(recommendations)`: Called when discovery finishes with sorted final results

Returns: `Promise<MintRecommendation[]>`

#### `subscribe(callbacks)`

Subscribe to live updates from Nostr.

```javascript
const unsubscribe = discovery.subscribe({
  onMintInfo: (info, event) => console.log('New mint:', info.url),
  onReview: (review, event) => console.log('New review:', review.url),
  onUpdate: (recommendations) => console.log('Updated:', recommendations.length)
});

// Later: unsubscribe()
```

#### `getRecommendations()`

Get current recommendations without fetching.

```javascript
const mints = discovery.getRecommendations();
```

#### `getReviewsForMint(url)`

Get cached reviews for a specific mint.

```javascript
const reviews = discovery.getReviewsForMint('https://mint.example.com');
```

#### `fetchReviewsForMint(url)`

Fetch reviews for a specific mint from Nostr.

```javascript
const reviews = await discovery.fetchReviewsForMint('https://mint.example.com');
```

#### `clearCache()`

Clear all cached data.

```javascript
await discovery.clearCache();
```

#### `close()`

Close all connections and subscriptions.

```javascript
discovery.close();
```

## Data Types

### MintReview

```javascript
{
  eventId: string,     // Nostr event ID
  pubkey: string,      // Author's public key
  created_at: number,  // Unix timestamp
  rating: number|null, // Rating 1-5 or null if no rating
  comment: string,     // Review text
  url: string          // Mint URL
}
```

### MintRecommendation

```javascript
{
  url: string,                    // Mint URL
  reviewsCount: number,           // Number of reviews (latest per author)
  ratingsCount: number,           // Reviews that carry a [X/5] rating
  averageRating: number|null,     // Average rating (1-5) or null
  score: number,                  // Ranking score (average pulled towards 3 by 2 imaginary reviews)
  info: object|undefined,         // HTTP /v1/info response
  error: boolean,                 // Whether last HTTP fetch failed
  lastHttpInfoFetchAt: number     // Unix timestamp of last fetch
}
```

## Nostr Protocol Details

### Kind 38172: Mint Info Events

Published by mint operators to announce their mint.

**Tags:**
- `u`: Mint URL (e.g., `["u", "https://mint.example.com", "cashu"]`)
- `d`: Unique identifier

**Content:** JSON with mint metadata (optional)

### Kind 38000: Review Events

User reviews for mints.

**Tags:**
- `k`: Kind being reviewed (`["k", "38172"]`)
- `u`: Mint URL(s) being reviewed

**Content:** Rating and comment in format `[X/5] optional comment`

Examples:
- `[5/5] Great mint, fast and reliable!`
- `[3/5]`
- `Just a comment without rating`

## Default Relays

```javascript
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.8333.space/',
  'wss://nos.lol',
  'wss://relay.primal.net'
];
```

## PHP Integration Patterns

### Option 1: Browser Script

Include the library in a PHP-served HTML page:

```php
<!-- In your PHP template -->
<script type="module">
  import { MintDiscovery } from '/js/mint-discovery/index.js';

  const discovery = MintDiscovery.create();
  const mints = await discovery.discover();

  // Send to PHP backend
  fetch('/api/mints', {
    method: 'POST',
    body: JSON.stringify(mints)
  });
</script>
```

### Option 2: Node.js API Server

Run a simple API server that PHP can call:

```javascript
// server.js
const http = require('http');
const { MintDiscovery } = require('./mint-discovery');

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/mints') {
    const discovery = MintDiscovery.create({ useStorage: false });
    const mints = await discovery.discover();
    discovery.close();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mints));
  }
});

server.listen(3001);
```

Then in PHP:

```php
$mints = json_decode(file_get_contents('http://localhost:3001/api/mints'), true);
```

### Option 3: CLI Script

Run as a command-line script:

```javascript
// fetch-mints.js
const { MintDiscovery } = require('./mint-discovery');

async function main() {
  const discovery = MintDiscovery.create({ useStorage: false });
  const mints = await discovery.discover();
  console.log(JSON.stringify(mints));
  discovery.close();
}

main();
```

Then in PHP:

```php
$output = shell_exec('node fetch-mints.js');
$mints = json_decode($output, true);
```

## Individual Components

You can use individual components directly:

```javascript
const { parseRatingAndComment } = require('./mint-discovery/review-parser');
const { createNostrClient } = require('./mint-discovery/nostr-client');
const { fetchMintInfo, fetchMintInfoBatch } = require('./mint-discovery/mint-info-fetcher');
const { createAggregator } = require('./mint-discovery/aggregator');
const { createStorage } = require('./mint-discovery/storage');

// Parse a review
const { rating, comment } = parseRatingAndComment('[4/5] Good mint!');

// Use Nostr client directly
const client = createNostrClient({ relays: ['wss://relay.damus.io'] });
const reviews = await client.fetchReviewEvents();
client.close();

// Fetch HTTP info
const result = await fetchMintInfo('https://mint.example.com');

// Use aggregator for custom processing
const aggregator = createAggregator();
aggregator.addReviews(reviews);
const sorted = aggregator.getRecommendations();
```

## License

MIT
