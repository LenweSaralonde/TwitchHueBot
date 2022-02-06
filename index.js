const tmi = require('tmi.js');
const { v3, discovery } = require('node-hue-api');
const LightState = v3.lightStates.LightState;

// Get configuration
const CONFIG = require('./config.js');
const {
	TWITCH_CHANNEL,
	COLOR_REWARD_ID,
	HUE_BRIDGE_USERNAME,
	RIGHT_KEY_LIGHT_ID,
	LEFT_KEY_LIGHT_ID,
	LEFT_LIGHTSTRIP_ID,
	RIGHT_LIGHTSTRIP_ID,
	BACK_LIGHT_ID,
	INITIAL_LIGHT_SETTINGS,
	COLOR_SCHEMES,
	COLOR_TRANSITION,
} = CONFIG;

// Light names
const LIGHT_NAMES = {
	[LEFT_KEY_LIGHT_ID]: 'Left key light',
	[RIGHT_KEY_LIGHT_ID]: 'Right key light',
	[BACK_LIGHT_ID]: 'Back light',
	[LEFT_LIGHTSTRIP_ID]: 'Left Lightstrip',
	[RIGHT_LIGHTSTRIP_ID]: 'Right Lightstrip',
};

// Saved scene name
const SAVED_SCENE_NAME = 'Twitch Hue Bot saved scene';

// Ordered Light IDs
const LIGHT_IDS = [
	LEFT_KEY_LIGHT_ID, RIGHT_KEY_LIGHT_ID, BACK_LIGHT_ID, LEFT_LIGHTSTRIP_ID, RIGHT_LIGHTSTRIP_ID,
];

// The maximum number of request the Hue bridge can perform per second
const MAX_REQUESTS_PER_SECOND = 10;

// Min and max temperatures for key lights, in Kelvin
const [MIN_TEMPERATURE, MAX_TEMPERATURE] = [2000, 6500];

// Hue bridge API object
let hueBridgeApi;

// Twitch client object
let twitchClient;

// Action queue promise
let actionQueue = Promise.resolve();

/**
 * Convert the temperature in Kelvin (K) into Mired color temperature (ct).
 * @param {number} k
 * @return {int}
 */
function kToCt(k) {
	const [ctMin, ctMax] = [153, 500];
	const kRange = MAX_TEMPERATURE - MIN_TEMPERATURE;
	const ctRange = ctMax - ctMin;
	const temp = (k - MIN_TEMPERATURE) / kRange;
	return Math.min(ctMax, Math.max(ctMin, Math.round(ctMax - temp * ctRange)));
}

/**
 * Indicates if the provided light ID has RGB support.
 * @param {int} lightId
 * @return {boolean}
 */
function hasRgbSupport(lightId) {
	return lightId === LEFT_LIGHTSTRIP_ID || lightId === RIGHT_LIGHTSTRIP_ID;
}

/**
 * Waits for the given amount of milliseconds.
 * @param {number} milli
 */
async function delay(milli) {
	return new Promise(resolve => setTimeout(resolve, milli));
}

/**
 * Enqueue asynchronous action.
 * @param {function<Promise>} asyncAction
 */
function enqueueAsyncAction(asyncAction) {
	actionQueue = actionQueue.then(asyncAction);
}

/**
 * Connect to the Hue bridge and returns the API object.
 * @return {Api}
 */
async function connectHueBridge() {
	// Find Hue bridge on the LAN
	const foundBridges = await discovery.nupnpSearch();
	const host = foundBridges[0].ipaddress;

	// Connect to the bridge
	hueBridgeApi = await v3.api.createLocal(host).connect(HUE_BRIDGE_USERNAME);

	return hueBridgeApi;
}

/**
 * Save the current scene.
 * @return {LightScene}
 */
async function saveScene() {
	const savedScene = v3.model.createLightScene();
	savedScene.name = SAVED_SCENE_NAME;
	savedScene.lights = [...LIGHT_IDS];
	return await hueBridgeApi.scenes.createScene(savedScene);
}

/**
 * Restore the provided scene.
 * @param {LightScene} scene
 */
async function restoreScene(scene) {
	await hueBridgeApi.scenes.activateScene(scene.id);
	await hueBridgeApi.scenes.deleteScene(scene.id); // We don't need this anymore
}

/**
 * Log the current light states
 */
async function logLightState() {
	for (let lightId of LIGHT_IDS) {
		const lightName = LIGHT_NAMES[lightId];
		const state = await hueBridgeApi.lights.getLightState(lightId);
		console.log(`State for ${lightName} (${lightId}):`, JSON.stringify(state));
	}
}

/**
 * Reset the light settings to the default
 */
async function resetLights() {
	console.log(`Resetting lights to their default settings...`);
	const promises = [];
	for (let key of Object.keys(INITIAL_LIGHT_SETTINGS)) {
		const lightId = CONFIG[key];
		const lightSettings = { ...INITIAL_LIGHT_SETTINGS[key] };

		// Convert temperature values in Kelvin into ct
		if (lightSettings.k !== undefined) {
			lightSettings.ct = kToCt(lightSettings.k);
		}

		// Always effects in the first place
		if (hasRgbSupport(lightId)) {
			promises.push(hueBridgeApi.lights.setLightState(lightId, new LightState().effectNone()));
		}

		// Apply light settings
		promises.push(hueBridgeApi.lights.setLightState(lightId, new LightState().populate(lightSettings).transition(100)));
	}
	await Promise.all(promises);
	console.log(`Done.`);
}

/**
 * Perform a test of each light to make sure they are properly configured.
 */
async function lightTest() {
	console.log(`Light test starting...`);
	const currentScene = await saveScene();

	// Turn all the lights off
	const promises = [];
	promises.push(hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()));
	promises.push(hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()));
	for (let lightId of LIGHT_IDS) {
		promises.push(hueBridgeApi.lights.setLightState(lightId, new LightState().off().transition(0)));
	}
	await Promise.all(promises);

	await delay(1500);

	// Make each light blink
	for (let lightId of LIGHT_IDS) {
		console.log(`Testing ${LIGHT_NAMES[lightId]} with ID ${lightId}...`);
		for (let blink = 1; blink <= 6; blink++) {
			await hueBridgeApi.lights.setLightState(lightId, new LightState().on().ct(kToCt(6500)).bri(254).transition(250));
			await hueBridgeApi.lights.setLightState(lightId, new LightState().off().transition(250));
		}
	}

	await delay(1500);

	// Restore the previous lights state
	console.log(`Restoring state...`);
	await restoreScene(currentScene);

	console.log(`Light test complete.`);
}

/**
 * Plays a rotating light effect.
 * @param {array} [rgb=[255, 64, 0]] RGB color of the Lightstrip
 * @param {int} [k=2000] Temperature of the keylights in Kelvin
 * @param {int} [num=6] Number of rotations to perform
 */
async function rotatingLight(rgb = [255, 64, 0], k = MIN_TEMPERATURE, num = 8) {
	console.log(`Playing rotating lights effect...`);

	// Set the flashing rate to the maximum allowed by the API
	const rate = 1000 / MAX_REQUESTS_PER_SECOND;

	// Convert color temperature
	const ct = kToCt(k);

	// Get the current lights state
	const currentScene = await saveScene();

	// Prepare light states
	const offState = new LightState().bri(1).transition(rate);
	const onState = new LightState().bri(254).transition(rate);

	// Disable effects and unneeded lights
	await Promise.all([
		hueBridgeApi.lights.setLightState(BACK_LIGHT_ID, new LightState().off().transition(rate)),
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
	]);

	// Set initial state
	// 0 0
	// 1 1
	await Promise.all([
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().on().rgb(rgb).bri(1).transition(rate)),
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().on().rgb(rgb).bri(1).transition(rate)),
		hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254).transition(rate)),
		hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254).transition(rate)),
	]);

	// Perform rotating red light effect
	for (let i = 1; i <= num; i++) {
		// 0 1
		// 0 1
		await Promise.all([
			hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, onState),
			hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, offState),
		]);

		// 1 1
		// 0 0
		await Promise.all([
			hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, onState),
			hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, offState),
		]);

		// 1 0
		// 1 0
		await Promise.all([
			hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, onState),
			hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, offState),
		]);

		// 0 0
		// 1 1
		await Promise.all([
			hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, onState),
			hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, offState),
		]);
	}

	// Restore previous lights state
	await restoreScene(currentScene);

	console.log(`Rotating lights effect complete.`);
}

/**
 * Plays a flashing light effect.
 * @param {int} [k=2000] Temperature in Kelvin
 * @param {int} [num=4] Number of flashes to perform
 */
async function flashingLight(k = MAX_TEMPERATURE, num = 8) {
	console.log(`Playing flashing lights effect...`);

	// Set the flashing rate to the maximum allowed by the API
	const rate = 1000 / MAX_REQUESTS_PER_SECOND;

	// Convert color temperature
	const ct = kToCt(k);

	// Get the current lights state
	const currentScene = await saveScene();

	// Disable effects and unneeded lights
	await Promise.all([
		hueBridgeApi.lights.setLightState(BACK_LIGHT_ID, new LightState().off().transition(0)),
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
	]);

	// Set initial state
	// 1 0
	// 1 0
	await Promise.all([
		hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(1).transition(0)),
		hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254).transition(0)),
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().on().ct(ct).bri(1).transition(0)),
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().on().ct(ct).bri(254).transition(0)),
		delay(rate * 4)
	]);

	// Prepare light states
	const offState = new LightState().bri(1).transition(0);
	const onState = new LightState().bri(254).transition(0);

	// Perform rotating red light effect
	for (let i = 1; i <= num; i++) {
		// 0 1
		// 0 1
		await Promise.all([
			hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, offState),
			hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, onState),
			hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, offState),
			hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, onState),
			delay(rate * 4)
		]);

		// 1 0
		// 1 0
		await Promise.all([
			hueBridgeApi.lights.setLightState(RIGHT_KEY_LIGHT_ID, offState),
			hueBridgeApi.lights.setLightState(LEFT_KEY_LIGHT_ID, onState),
			hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, offState),
			hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, onState),
			delay(rate * 4)
		]);
	}

	// Restore previous lights state
	await restoreScene(currentScene);

	console.log(`Flashing lights effect complete.`);
}

/**
 * Parse command name from Twitch chat message
 * @param {string} message
 * @return {string} Command name
 */
function getCommandName(message) {
	const matches = message.toLowerCase().match(/\!([a-z0-9]+)/);
	if (matches) {
		return matches[1];
	}
	return null;
}

/**
 * Reset lights from Twitch command
 */
function doResetLights() {
	enqueueAsyncAction(resetLights);
}

/**
 * Perform light test from Twitch command
 */
function doLightTest() {
	enqueueAsyncAction(lightTest);
}

/**
 * Perform light effect when a raid occurs
 */
function doRaidEffect() {
	enqueueAsyncAction(() => rotatingLight([255, 64, 0], MIN_TEMPERATURE, 13));
}

/**
 * Perform light effect when someone subscribes to the channel
 */
function doSubscribeEffect() {
	enqueueAsyncAction(() => flashingLight(MAX_TEMPERATURE, 5));
}

/**
 * Perform light effect when someone gifts several subs to the channel
 */
function doSubGiftEffect() {
	enqueueAsyncAction(() => flashingLight(MAX_TEMPERATURE, 11));
}

/**
 * Perform light effect when someone gifts a certain amount of bits
 */
function doBitsEffect() {
	enqueueAsyncAction(() => flashingLight(MAX_TEMPERATURE, 2));
}

/**
 * Change scene color based on the parameters parsed from the chat message
 * @param {string} message
 */
function doChangeSceneColor(message) {

	let settings = [];

	// Set using HEX code
	const matches = message.toLowerCase().match(/(#([0-9a-f]{6}))(.*#([0-9a-f]{6}))?/u);
	if (matches && matches[2]) {
		const hex1 = matches[2];
		const hex2 = matches[4] || hex1;
		const rgb1 = [parseInt(hex1.substring(0, 1), 16), parseInt(hex1.substring(2, 3), 16), parseInt(hex1.substring(4, 5), 16)];
		const rgb2 = [parseInt(hex2.substring(0, 1), 16), parseInt(hex2.substring(2, 3), 16), parseInt(hex2.substring(4, 5), 16)];
		settings.push({ on: true, rgb: rgb1, name: rgb1 });
		settings.push({ on: true, rgb: rgb2, name: rgb2 });
	} else {
		// Set by color scheme name
		message = ' ' + message.toLowerCase().replace(/\s+/g, ' ') + ' ';
		for (let colorScheme of COLOR_SCHEMES) {
			// Filter out duplicates in keywords list
			const keywords = [...new Set(colorScheme.keywords)];
			for (let keyword of keywords) {
				// Scheme keywoard has been found
				const position = message.indexOf(` ${keyword} `)
				if (position !== -1) {
					// Determine scheme order by the keyword position in the message.
					// Give higher priority (lower order) to the schemes having multiple settings.
					const order = position + ((colorScheme.settings.length === 1) ? message.length : 0);
					for (let setting of colorScheme.settings) {
						// Keep the order to order the colors afterwards
						settings.push({ ...setting, order, name: keyword });
					}
				}
			}
		}
	}

	if (settings.length === 0) {
		// No setting: no color change.
		console.log(`Unknown color scheme.`);
		return;
	} else if (settings.length === 1) {
		// Duplicate setting
		settings.push(settings[0]);
	}

	// Reorder color by their order in the message string
	settings.sort((a, b) => (a.order || 0) - (b.order || 0));

	// Display console message
	const schemeName = (settings[0].name !== settings[1].name) ? `${settings[0].name} ${settings[1].name}` : settings[0].name;
	console.log(`Setting color scheme: ${schemeName}...`);

	// Apply changes
	enqueueAsyncAction(() => Promise.all([
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
		hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().populate({ ...settings[0], effect: 'none' }).transition(COLOR_TRANSITION)),
		hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().populate({ ...settings[1], effect: 'none' }).transition(COLOR_TRANSITION)),
		delay(COLOR_TRANSITION)
	]));

	// Start effects after the transition ends
	enqueueAsyncAction(() => Promise.all([
		settings[0].effect !== 'none' && hueBridgeApi.lights.setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effect(settings[0].effect)),
		settings[1].effect !== 'none' && hueBridgeApi.lights.setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effect(settings[1].effect)),
	]));

	console.log(`Color scheme applied.`);
}

/**
 * Init the Twitch bot
 */
async function initBot() {
	// Connect to the Philips Hue bridge first
	console.log(`Connecting to the Hue bridge...`);
	await connectHueBridge();
	console.log(`Hue bridge connected.`);

	// Reset lights
	doResetLights();

	// Instanciate Twitch chat client
	twitchClient = new tmi.Client({ channels: [TWITCH_CHANNEL] });

	// Message handler
	twitchClient.on('message', (channel, context, message, self) => {
		// Don't listen to my own messages..
		if (self) return;

		// Only accept commands from broadcaster
		const command = getCommandName(message);
		if (command !== null && context['display-name'] === TWITCH_CHANNEL) {
			console.log(`Received ${command} command from broadcaster ${context['display-name']}.`);
			switch (command) {
				// Reset light settings
				case 'resetlight':
				case 'resetlights':
				case 'lightreset':
				case 'lightsreset':
					return doResetLights();

				// Perform light test
				case 'testlight':
				case 'lighttest':
				case 'testlights':
				case 'lightstest':
					return doLightTest();

				// Test bits effect
				case 'bittest':
				case 'bitstest':
				case 'testbit':
				case 'testbits':
					return doBitsEffect();

				// Test subscribe effect
				case 'subtest':
				case 'testsub':
				case 'subscribetest':
				case 'testsubscribe':
					return doSubscribeEffect();

				// Test sub gift effect
				case 'subgifttest':
				case 'testsubgift':
					return doSubGiftEffect();

				// Test raid effect
				case 'raidtest':
				case 'testraid':
				case 'testrotating':
				case 'rotatingtest':
				case 'gyrotest':
				case 'testgyro':
					return doRaidEffect();

				// Log lights state
				case 'lightstate':
				case 'lightsstate':
					return logLightState();

				// Change scene colors
				case 'color':
				case 'colors':
				case 'setcolor':
				case 'setcolors':
					return doChangeSceneColor(message);

				default:
					console.log('Unknown command.');
					return;
			}
		}

		// Change scene color using points
		if (context['custom-reward-id'] === COLOR_REWARD_ID) {
			console.log(`${context['display-name']} redeemed color change using channel points.`);
			doChangeSceneColor(message);
		}
	});

	// Raid handler
	twitchClient.on('raided', (channel, username, viewers) => {
		console.log(`${username} raided with ${viewers}.`);
		doRaidEffect();
	});

	// Subscription handlers
	twitchClient.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
		console.log(`${username} gave a subscription to ${recipient}.`);
		doSubscribeEffect();
	});
	twitchClient.on('subscription', (channel, username, method, message, userstate) => {
		console.log(`${username} subscribed to the channel.`);
		doSubscribeEffect();
	});
	twitchClient.on('resub', (channel, username, months, message, userstate, methods) => {
		let cumulativeMonths = ~~userstate["msg-param-cumulative-months"];
		console.log(`${username} resubscribed to the channel (months: ${cumulativeMonths}).`);
		doSubscribeEffect();
	});
	twitchClient.on('submysterygift', (channel, username, numbOfSubs, methods, userstate) => {
		console.log(`${username} gave away ${numbOfSubs} subscriptions.`);
		if (numbOfSubs >= 5) {
			doSubGiftEffect();
		} else {
			doSubscribeEffect();
		}
	});

	// Bits handler
	twitchClient.on('cheer', (channel, userstate, message) => {
		console.log(`${userstate['display-name']} cheered with ${userstate.bits} bits.`);
		if (userstate.bits && userstate.bits >= 1000) {
			doBitsEffect();
		}
	});

	// Connect to Twitch chat
	console.log(`Connecting to the Twitch chat...`);
	twitchClient.connect();
	console.log(`Twitch chat connected.`);
}

/**
 * Starts the bot.
 * Attempts to restart in case of error.
 */
async function startBot() {
	// Start bot
	try {
		await initBot();
	} catch (e) {
		console.error('The bot failed to start:', e);
		console.log('Retrying in 10 seconds...');
		setTimeout(startBot, 10000);
	}
}

// Start the bot!
startBot();
