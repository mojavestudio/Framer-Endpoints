# Framer Endpoints

Google Apps Script endpoints for managing Framer plugin purchases via Stripe webhooks and purchase verification.

## Overview

This repository contains two Google Apps Script endpoints:

1. **StripeEndpoint.js** - Receives Stripe webhook events and automatically syncs purchase data to a Google Sheet
2. **FramerEndpoint.js** - Provides a read-only API endpoint to verify purchases and bind them to user IDs

## Features

### StripeEndpoint.js
- Receives Stripe webhook events (`payment_intent.succeeded`, `charge.succeeded`, `checkout.session.*`)
- Performs UPSERT operations on Google Sheets (updates existing rows or creates new ones)
- Uses Payment Intent ID as the unique lookup key
- Handles concurrent webhook events with locking
- Maps Stripe product IDs to plugin names
- Supports optional webhook token authentication

### FramerEndpoint.js
- Validates purchases by email and access code
- Optionally binds purchases to Framer user IDs
- Supports plugin name filtering
- Implements caching for read-only verification requests
- Returns JSON or JSONP responses

## Setup

### Prerequisites
- A Google account with access to Google Sheets
- A Stripe account (for StripeEndpoint.js)
- A Google Sheet with the following columns:
  - `Client Name`
  - `Client Email`
  - `Paid At`
  - `Access Code`
  - `Plugin Name`
  - `Framer User ID`
  - `Event ID` (required for StripeEndpoint.js)

### Installation

1. **Create a new Google Apps Script project:**
   - Go to [script.google.com](https://script.google.com)
   - Click "New Project"

2. **Copy the code:**
   - Copy the contents of `StripeEndpoint.js` or `FramerEndpoint.js` into your Apps Script project
   - Or create separate projects for each endpoint

3. **Configure the script:**
   - Update `SPREADSHEET_ID` with your Google Sheet ID (found in the sheet URL)
   - Update `SHEET_NAME` if your sheet tab has a different name
   - For StripeEndpoint.js: Optionally configure `PRODUCT_ID_TO_PLUGIN` mapping

4. **Deploy as a web app:**
   - Click "Deploy" → "New deployment"
   - Choose "Web app" as the type
   - Set execution as "Me" and access as "Anyone"
   - Copy the web app URL

### StripeEndpoint.js Configuration

#### Webhook Token (Optional)
To add token-based authentication:
1. In Apps Script: Project Settings → Script properties
2. Add a property with key `WEBHOOK_TOKEN` and a random string value
3. Append `?token=YOUR_SECRET` to your Stripe webhook URL
4. Uncomment the token validation code in `doPost()`

#### Product ID Mapping
Map your Stripe product IDs to plugin names:
```javascript
const PRODUCT_ID_TO_PLUGIN = {
  'prod_XXXXXXXXXXXXXX': 'Plugin One',
  'prod_YYYYYYYYYYYYYY': 'Plugin Two',
};
```

### FramerEndpoint.js Configuration

#### Caching
Adjust cache duration (default: 5 minutes):
```javascript
const CACHE_SECONDS = 300; // Change to your preferred duration
```

## Usage

### StripeEndpoint.js

**Webhook URL:**
```
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

Configure this URL in your Stripe Dashboard under Webhooks.

**Supported Events:**
- `payment_intent.succeeded`
- `charge.succeeded`
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

### FramerEndpoint.js

**Base URL:**
```
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

**Query Parameters:**
- `email` (required) - Purchaser email address
- `access_code` (required) - Receipt/invoice/access code
- `plugin` or `plugin_name` (optional) - Plugin name to filter by
- `framer_user_id` (optional) - Framer user ID to bind purchase to
- `bind=1` (optional) - Explicitly request binding
- `nocache=1` (optional) - Bypass cached responses
- `callback` (optional) - JSONP callback name

**Example Requests:**
```
# Simple verification
GET /exec?email=user@example.com&access_code=ABC123

# Verification with plugin filter
GET /exec?email=user@example.com&access_code=ABC123&plugin=MyPlugin

# Verification and auto-bind
GET /exec?email=user@example.com&access_code=ABC123&framer_user_id=user123

# Explicit bind
GET /exec?email=user@example.com&access_code=ABC123&framer_user_id=user123&bind=1

# JSONP request
GET /exec?email=user@example.com&access_code=ABC123&callback=handleResponse
```

**Response Format:**
```json
{
  "ok": true,
  "valid": true,
  "bound": false,
  "project_name": "Project Name",
  "action": "auto_bound"
}
```

## Sheet Structure

Both endpoints expect a Google Sheet with the following columns (in any order):

| Column Name | Description | Required |
|------------|-------------|----------|
| Client Name | Customer/project name | No |
| Client Email | Customer email address | Yes |
| Paid At | Payment timestamp | No |
| Access Code | Receipt number/invoice ID | Yes |
| Plugin Name | Name of the plugin/product | Yes |
| Framer User ID | Bound user identifier | Yes |
| Event ID | Payment Intent ID (pi_...) | StripeEndpoint only |

## Security Considerations

- **StripeEndpoint.js**: Consider enabling webhook token authentication for production use
- **FramerEndpoint.js**: This is a read-only endpoint, but consider adding rate limiting for production
- Both endpoints require proper Google Sheets permissions
- Never commit actual spreadsheet IDs or secrets to version control

## Error Handling

Both endpoints return JSON responses with an `ok` field:
- `ok: true` - Request processed successfully
- `ok: false` - Error occurred (check `error` field)

## License

This project is provided as-is for use with Framer plugins and Stripe payments.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

