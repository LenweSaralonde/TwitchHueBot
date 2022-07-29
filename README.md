# TwitchHueBot

Simple Twitch chatbot to control your Philips Hue lights by your stream chat. Feel free to fork and adapt it for to your own needs.

## Features

### Lights
The bot controls the following lights:
* 2 key lights (left and right) with variable temperature.
* 1 backlight with variable temperature.
* 2 RGB Lightstrips for the scenery (left and right).

### Channel reward to change the color of the Lightstrips
The viewers can change the color of your lightstrips using their channel points by typing the name of the color(s) or the scheme they want in the redeem message.

### Raid alerts
When the channel is being raided by another streamer, a red rotating light alert is played.

### Sub and bit alerts
When a viewer subscribes to the channel, makes a sub gift or gives 1000 or more bits, a flashing alert is played.

### Default settings
You can set the default state of your lights in the `config.js` file that is applied when the bot starts.

### Broadcaster commands
As the broadcaster, you can also use a few commands in the chat to make tests and change the scenery color.

## Installation

### Create user ID on the Philips Hue bridge

1. Find the IP address of your Hue bridge: https://discovery.meethue.com/ .
2. Head to `http://<bridge ip address>/debug/clip.html` .
3. Press the button on the Hue bridge.
4. Make a `POST` request to path `/api` with the body: `{"devicetype":"twitch_hue_bot"}`
5. Get the resulting `username` value.

Check the online documentation to learn more: https://developers.meethue.com/develop/get-started-2/

### Create the Twitch reward

1. Open your Twitch.tv dashboard.
2. Head to **Viewer rewards** / **Channel points**.
3. Click **Manage Rewards & Challenges**.
4. Add New Custom Reward.
5. Set a name, amount and description, as you like.
6. Make sure to check **Require Viewer to Enter Text**.
7. Also check **Skip Reward Requests Queue**.
8. Click **Create** when you're done.
9. Right click on the **Edit** button of the reward you just created then choose **Inspect**.
10. Copy the value of the `data-reward-id` attribute of the `<button>` tag to get the reward ID.

### Configure and install the bot

1. Copy the `config.example.js` to `config.js`.
2. Edit `config.js` the values for `HUE_BRIDGE_USERNAME`, `COLOR_REWARD_ID`, the IDS of your lights and your Twitch channel name.
3. Type `npm i` to install.

## Run the bot

### Start command

Run the bot before starting your stream using the `npm run start` command.

### Broadcaster commands

You can use the following commands in your Twitch chat while the bot is running:
* `!color <color1> [<color2>]` Change the colors of the Lightstrips. Colors can be scheme keywords defined in the config.js file (`red`, `blue`, `cyberpunk`...) or HTML hex codes (`#FF0080`).
* `!resetlight` Reset the light settings to the default.
* `!testlights` Test each one of the lights to make sure their ID are correct. The results are displayed in the Node.js console.
* `!lightstate` Display the current state of each light in the Node.js console.
* `!testraid [<username> [<viewers>]]` Test raid.
* `!testbits [<username> [<bits>]]` Test bits donation.
* `!testsub [<username> [<message>]]` Test subscription.
* `!testresub [<username> [<total months> [<months streak> [<message>]]]]` Test resub.
* `!testsubgift [<username> [<recipient> [<months streak>]]]` Test single sub gift.
* `!testsubgifts [<username> [<number of subs>]]` Test mystery multiple sub gift.

## Trigger effects from external alert box (advanced)

If you're using an external alert box such as Streamlabs Alert Box in conjunction with TwitchHueBot, the light effects might play out of sync with the alert box animation.

To solve this, you can configure TwitchHueBot to trigger the light effects using a HTTP REST API instead of using Twitch's events, then add custom JS code to your alert box trigger TwitchHueBot's REST API.

The available API endpoints are:
* `/raid`: Channel is being raided.
* `/subscribe`: One user subscribed to the channel.
* `/subgift`: Several subscriptions have been given away in the channel.
* `/bits`: A significant amount of bits have been given.

To enable the HTTP REST API, set a port value to `HTTP_PORT` in `config.js` (ie `666`).

### Configuration for Streamlabs Alert Box

On Streamlabs, you have to set a custom `JS` for every alert you want to trigger an effect.

For example, if TwitchHueBot's REST API runs on port `666`, to trigger the `subscribe` effect, use the following code:

```javascript
$.get('http://localhost:666/subscribe');
```