# Mint Discovery Interface Guide

This document describes the recommended user interface for displaying Cashu mint discovery results.

## Overview

The mint discovery interface should help users:
1. Browse available mints sorted by community trust (reviews)
2. See key information at a glance (rating, review count, supported features)
3. Read detailed reviews before choosing a mint
4. Quickly identify mint status (online/offline, errors)

---

## Main Mint List View

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Discover Mints                                    [↻ Refresh]  │
├─────────────────────────────────────────────────────────────────┤
│  Found 47 mints • Last updated: 2 minutes ago                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ★ 4.8  (23 reviews)                        [● Online]   │   │
│  │ Mint Name Here                                          │   │
│  │ https://mint.example.com                                │   │
│  │ ───────────────────────────────────────────────────     │   │
│  │ Lightning • Multimint • NUT-10 P2PK                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ★ 4.5  (12 reviews)                        [● Online]   │   │
│  │ Another Mint                                            │   │
│  │ https://another-mint.com                                │   │
│  │ ───────────────────────────────────────────────────     │   │
│  │ Lightning • On-chain                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ★ ---  (0 reviews)                         [○ Offline]  │   │
│  │ New Mint                                                │   │
│  │ https://new-mint.com                                    │   │
│  │ ───────────────────────────────────────────────────     │   │
│  │ Unable to fetch mint info                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mint Card Components

Each mint card should display:

| Element | Source | Notes |
|---------|--------|-------|
| **Rating** | `averageRating` | Show as stars (★) or number. Display "---" if null |
| **Review count** | `reviewsCount` | e.g., "(23 reviews)" |
| **Status indicator** | `error` field | Green dot = online, Red dot = offline/error |
| **Mint name** | `info.name` | From HTTP /v1/info response |
| **URL** | `url` | The mint's base URL |
| **Features** | `info.nuts` | Parse supported NUTs from info |

### Status Indicators

| Status | Indicator | Condition |
|--------|-----------|-----------|
| Online | 🟢 or `[● Online]` | `error === false` and `info` exists |
| Offline | 🔴 or `[○ Offline]` | `error === true` |
| Unknown | ⚪ or `[○ Unknown]` | No HTTP fetch attempted yet |
| Loading | ⏳ or spinner | Currently fetching |

### Sorting (Default)

Mints are pre-sorted by the library:
1. **Primary**: Review count (descending) - most reviewed first
2. **Secondary**: Average rating (descending) - highest rated first

### Optional Filters

Consider adding filter options:
- **Status**: Online only / All
- **Minimum reviews**: 0 / 5+ / 10+
- **Minimum rating**: Any / 3+ / 4+
- **Features**: Lightning / On-chain / P2PK / etc.

---

## Mint Detail View

When a user clicks on a mint card:

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Back                                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Mint Name Here                                    [● Online]   │
│  https://mint.example.com                                       │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ★★★★★  4.8 average  •  23 reviews                      │   │
│  │  ████████████████████░░░░  5 stars: 18                  │   │
│  │  ████████░░░░░░░░░░░░░░░░  4 stars: 4                   │   │
│  │  ██░░░░░░░░░░░░░░░░░░░░░░  3 stars: 1                   │   │
│  │  ░░░░░░░░░░░░░░░░░░░░░░░░  2 stars: 0                   │   │
│  │  ░░░░░░░░░░░░░░░░░░░░░░░░  1 star:  0                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ─── Mint Info ───────────────────────────────────────────────  │
│                                                                 │
│  Description: A reliable Cashu mint for everyone                │
│  Contact: admin@example.com                                     │
│  Version: Nutshell/0.15.0                                       │
│                                                                 │
│  ─── Supported Features ──────────────────────────────────────  │
│                                                                 │
│  [✓] NUT-04 Lightning                                          │
│  [✓] NUT-05 On-chain                                           │
│  [✓] NUT-07 Token state check                                  │
│  [✓] NUT-08 Overpaid fees                                      │
│  [✓] NUT-10 P2PK spending conditions                           │
│  [✓] NUT-11 P2PK signature flags                               │
│                                                                 │
│  ─── Reviews ─────────────────────────────────────────────────  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ★★★★★  5/5                           2 days ago        │   │
│  │  npub1abc...xyz                                         │   │
│  │  Great mint! Fast and reliable, been using for months.  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ★★★★☆  4/5                           1 week ago        │   │
│  │  npub1def...uvw                                         │   │
│  │  Works well, occasional slowness during peak hours.     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ★★★★★  5/5                           2 weeks ago       │   │
│  │  npub1ghi...rst                                         │   │
│  │  (no comment)                                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                                         [Connect to this mint]  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Rating Breakdown

Show a histogram of ratings:
- Calculate from reviews array
- Display as horizontal bars
- Show count for each star level

### Mint Info Section

Display from `info` object (HTTP /v1/info response):

| Field | Source |
|-------|--------|
| Description | `info.description` |
| Contact | `info.contact` |
| Version | `info.version` |
| MOTD | `info.motd` (message of the day) |

### Supported Features

Parse from `info.nuts` object. Common NUTs to highlight:

| NUT | Feature |
|-----|---------|
| NUT-04 | Lightning payments (minting/melting) |
| NUT-05 | On-chain payments |
| NUT-07 | Token state check (spendable check) |
| NUT-08 | Overpaid lightning fees returned |
| NUT-10 | P2PK spending conditions |
| NUT-11 | P2PK signature flags |
| NUT-12 | DLEQ proofs |
| NUT-17 | WebSocket subscriptions |

### Reviews Section

Display each review with:

| Element | Source | Notes |
|---------|--------|-------|
| Rating | `review.rating` | Show as stars, or "No rating" if null |
| Time | `review.created_at` | Format as relative time (e.g., "2 days ago") |
| Author | `review.pubkey` | Show as npub (bech32) or truncated hex |
| Comment | `review.comment` | Full review text, or "(no comment)" if empty |

---

## Loading States

### Initial Load

```
┌─────────────────────────────────────────────────────────────────┐
│  Discover Mints                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                         ⏳                                      │
│                                                                 │
│              Connecting to Nostr relays...                      │
│              Fetching mint information...                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Progress Indicator

Use the `onProgress` callback to show detailed progress:

```javascript
discovery.discover({
  onProgress: ({ phase, step, url }) => {
    if (phase === 'nostr' && step === 'mint-info') {
      showStatus('Fetching mint announcements...');
    } else if (phase === 'nostr' && step === 'reviews') {
      showStatus('Fetching reviews...');
    } else if (phase === 'http') {
      showStatus(`Checking mint status... (${fetchedCount}/${totalCount})`);
    } else if (phase === 'done') {
      hideStatus();
    }
  }
});
```

### Incremental Loading

Show mints as they're discovered, update status as HTTP info arrives:

```javascript
// Show mints immediately after Nostr fetch
const mints = await discovery.discover({ skipHttpFetch: true });
renderMintList(mints); // All show as "Unknown" status

// Then fetch HTTP info with live updates
discovery.subscribe({
  onUpdate: (updatedMints) => {
    renderMintList(updatedMints); // Status updates as info arrives
  }
});
```

---

## Empty States

### No Mints Found

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                         🔍                                      │
│                                                                 │
│              No mints found                                     │
│                                                                 │
│              This could mean:                                   │
│              • Nostr relays are unreachable                     │
│              • No mints have been announced yet                 │
│                                                                 │
│                      [Try Again]                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### No Reviews for Mint

```
┌─────────────────────────────────────────────────────────────────┐
│  ★ ---  (0 reviews)                                             │
│                                                                 │
│  This mint has no reviews yet.                                  │
│  Be the first to review it!                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Error States

### Connection Error

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                         ⚠️                                      │
│                                                                 │
│              Failed to connect to relays                        │
│                                                                 │
│              Please check your internet connection              │
│              and try again.                                     │
│                                                                 │
│                      [Retry]                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mint Offline

```
┌─────────────────────────────────────────────────────────────────┐
│  ★ 4.5  (12 reviews)                              [○ Offline]   │
│  Some Mint                                                      │
│  https://some-mint.com                                          │
│  ───────────────────────────────────────────────────            │
│  ⚠️ Could not connect to mint                                   │
│  Last seen: 3 hours ago                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Responsive Design

### Mobile (< 600px)

- Stack cards vertically, full width
- Reduce padding
- Collapse feature tags to icons
- Use bottom sheet for mint details

### Tablet (600px - 1024px)

- 2-column grid for mint cards
- Side panel for mint details

### Desktop (> 1024px)

- 3-column grid for mint cards
- Modal or side panel for mint details
- Show more info inline on cards

---

## Color Scheme

### Light Theme

| Element | Color |
|---------|-------|
| Background | `#FFFFFF` |
| Card background | `#F8F9FA` |
| Text primary | `#212529` |
| Text secondary | `#6C757D` |
| Rating stars | `#FFC107` (gold) |
| Online status | `#28A745` (green) |
| Offline status | `#DC3545` (red) |
| Unknown status | `#6C757D` (gray) |

### Dark Theme

| Element | Color |
|---------|-------|
| Background | `#121212` |
| Card background | `#1E1E1E` |
| Text primary | `#E0E0E0` |
| Text secondary | `#9E9E9E` |
| Rating stars | `#FFD54F` (gold) |
| Online status | `#4CAF50` (green) |
| Offline status | `#F44336` (red) |
| Unknown status | `#9E9E9E` (gray) |

---

## Accessibility

### Requirements

- All interactive elements must be keyboard accessible
- Minimum touch target size: 44x44px
- Color contrast ratio: 4.5:1 for normal text, 3:1 for large text
- Screen reader labels for all icons and status indicators

### ARIA Labels

```html
<!-- Rating -->
<span aria-label="4.8 out of 5 stars">★★★★★ 4.8</span>

<!-- Status -->
<span aria-label="Mint is online" class="status-online">●</span>
<span aria-label="Mint is offline" class="status-offline">○</span>

<!-- Review count -->
<span aria-label="23 reviews">(23 reviews)</span>
```

---

## Animation Guidelines

### Subtle Transitions

- Card hover: slight elevation/shadow change (150ms)
- Status change: fade transition (200ms)
- List reorder: smooth position transition (300ms)
- Loading spinner: continuous rotation

### Skeleton Loading

While loading, show placeholder cards:

```
┌─────────────────────────────────────────────────────────────────┐
│  ████████  ██████████                         ████████████      │
│  ████████████████████████████                                   │
│  ██████████████████████████████████████                         │
│  ───────────────────────────────────────────────────            │
│  ████████  ████████  ████████████                               │
└─────────────────────────────────────────────────────────────────┘
```

Use CSS animation to pulse the skeleton blocks.

---

## Implementation Example (HTML/CSS)

```html
<div class="mint-card" data-status="online">
  <div class="mint-header">
    <div class="mint-rating">
      <span class="stars">★★★★★</span>
      <span class="rating-value">4.8</span>
      <span class="review-count">(23 reviews)</span>
    </div>
    <div class="mint-status">
      <span class="status-dot"></span>
      <span class="status-text">Online</span>
    </div>
  </div>

  <h3 class="mint-name">Mint Name Here</h3>
  <p class="mint-url">https://mint.example.com</p>

  <div class="mint-features">
    <span class="feature-tag">Lightning</span>
    <span class="feature-tag">Multimint</span>
    <span class="feature-tag">P2PK</span>
  </div>
</div>

<style>
.mint-card {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: box-shadow 150ms ease;
}

.mint-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.mint-card[data-status="online"] .status-dot {
  background: #28A745;
}

.mint-card[data-status="offline"] .status-dot {
  background: #DC3545;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}

.stars {
  color: #FFC107;
}

.feature-tag {
  background: var(--tag-bg);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  margin-right: 4px;
}
</style>
```

---

## Data Mapping Reference

Quick reference for mapping library data to UI:

```javascript
// MintRecommendation → UI
const card = {
  name: mint.info?.name || 'Unknown Mint',
  url: mint.url,
  rating: mint.averageRating?.toFixed(1) || '---',
  reviewCount: mint.reviewsCount,
  isOnline: !mint.error && mint.info != null,
  features: parseFeatures(mint.info?.nuts),
  description: mint.info?.description,
  lastSeen: mint.lastHttpInfoFetchAt
    ? formatRelativeTime(mint.lastHttpInfoFetchAt * 1000)
    : null
};

// MintReview → UI
const reviewCard = {
  rating: review.rating, // 1-5 or null
  comment: review.comment || '(no comment)',
  author: formatPubkey(review.pubkey), // npub or truncated
  time: formatRelativeTime(review.created_at * 1000)
};

// Helper: Parse NUTs to feature names
function parseFeatures(nuts) {
  if (!nuts) return [];
  const features = [];
  if (nuts['4']) features.push('Lightning');
  if (nuts['5']) features.push('On-chain');
  if (nuts['7']) features.push('State check');
  if (nuts['10']) features.push('P2PK');
  if (nuts['17']) features.push('WebSocket');
  return features;
}
```
