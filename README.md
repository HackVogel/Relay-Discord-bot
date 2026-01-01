# Relay-Discord-Bot

This bot is designed to protect user accounts on Discord by anonymizing messages sent in specific channels. It's common for content in channels to potentially lead to warnings or even account suspensions from Discord.

This bot prevents such issues by deleting a user's original message and immediately re-posting the content via a webhook. This severs the direct link between the content and the original author's Discord account.

---

## How It Works

The RelayBot monitors a predefined set of channels. When a new message from a non-administrator user is detected, it executes the following steps:

1.  **Delete Original Message**: The user's message is immediately removed.
2.  **Re-post Content**: The text and any attachments are sent again through a channel-specific webhook. The name and avatar are dynamically set to match the original author.
3.  **Efficient Management**: Instead of deleting the webhook after each use, the bot maintains **one persistent webhook per channel**, which is significantly more performant and respects Discord's API limits.
4.  **Daily Rotation**: To ensure reliability and freshness, all of the bot's webhooks are **automatically deleted and recreated every 24 hours**.

---

## Features

-   **Message Relaying**: Protects users by re-posting messages via webhooks.
-   **Efficient Webhook Management**: Utilizes one reusable webhook per channel for maximum performance.
-   **Daily Rotation**: Automatically renews all webhooks every 24 hours.
-   **Rate-Limiting**: Prevents spam by limiting messages per minute.
-   **Simple Configuration**: All setup is handled through a single `.env` file.

---

### 7. Configure Relay Channels (Important!)

Use the following slash command directly in Discord:
-   **Add a channel:** `/relay addchannel` and select the desired channel.
-   **Remove a channel:** `/relay removechannel` and select the channel to remove.

The bot will only become active in a channel after it has been added with this command.

## Installation & Configuration

Follow these steps to set up the bot on your own server.

### 1. Prerequisites
-   [Node.js](https://nodejs.org/)
-   A Discord Bot Account with a Token and Client ID from the [Discord Developer Portal](https://discord.com/developers/applications).


### 2. Clone the Repository
```bash
git clone https://github.com/HackVogel/Relay-Discord-bot.git
cd Relay-Discord-bot-main

