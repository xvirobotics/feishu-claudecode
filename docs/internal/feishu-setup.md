# Feishu App Setup Guide

← back to [CLAUDE.md](../../CLAUDE.md)

(飞书机器人配置)

This is the step-by-step procedure to configure a Feishu bot for this bridge service. Can be performed via browser automation or manually.

## Step 1: Create the App

1. Go to **飞书开放平台开发者控制台**: https://open.feishu.cn/app
2. Click **"Create Custom App"**
3. Fill in:
   - **Name**: e.g. "Claude Code"
   - **Description**: e.g. "Feishu to Claude Code bridge bot"
   - **Icon**: Pick any icon and color
4. Click **Create**

## Step 2: Record Credentials

1. In the app dashboard, go to **Credentials & Basic Info** (left sidebar)
2. Copy the **App ID** (e.g. `cli_xxxx`) and **App Secret**
3. These go into `.env` as `FEISHU_APP_ID` and `FEISHU_APP_SECRET`

## Step 3: Add Bot Capability

1. Go to **Add Features** (left sidebar under Features)
2. Find **Bot** and click **"+ Add"**
3. This enables the bot feature and adds a "Bot" menu in the sidebar

## Step 4: Configure Permissions

1. Go to **Permissions & Scopes** (left sidebar under Development Configuration)
2. Click **"Add permission scopes to app"** (blue button)
3. In the popup dialog, search for `im:message`
4. Check these two scopes:
   - **`im:message`** — Read and send messages in private and group chats
   - **`im:message:readonly`** — Read messages in private and group chats
   - **`im:resource`** — Upload images and files (needed to send output files back to chat)
   - **`im:chat:readonly`** — Read chat info (needed for 2-member group detection)
5. Click **"Add Scopes"**

## Step 5: Configure Events (requires running service)

> **IMPORTANT**: The subscription mode "persistent connection" requires the bot service to be running when you save. Start the service first (`npm run dev`), then configure this step.

1. Go to **Events & Callbacks** (left sidebar)
2. Click the edit icon next to **Subscription mode**
3. Select **"Receive events through persistent connection"** (Recommended)
4. Click **Save** — Feishu will validate the WebSocket connection
5. Click **"Add Events"** (now enabled)
6. Search for `im.message.receive`
7. Check **"Message received"** (`im.message.receive_v1`)
8. Click **Confirm**
9. When prompted for suggested scopes, click **"Add Scopes"** to add the recommended "Obtain private messages sent to the bot" scope

## Step 6: Publish the App

1. Click **"Create Version"** in the top banner (or go to Version Management & Release)
2. Fill in:
   - **App version**: e.g. "1.0.0"
   - **Update Notes**: e.g. "Initial release"
3. Default features should be "Bot" for both mobile and desktop
4. Click **Save**, then **Publish** in the confirmation dialog
5. If the org allows auto-approval for small apps, it goes live instantly

## Step 7: Test

1. Open Feishu Messenger
2. Search for your bot name (e.g. "Claude Code")
3. Send a test message
4. The bot should respond with a streaming card showing Claude's response
