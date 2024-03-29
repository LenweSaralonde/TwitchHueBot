const tmi = require('tmi.js');
const { v3, discovery } = require('node-hue-api');
const LightState = v3.lightStates.LightState;
const http = require('http');

// Get configuration
const CONFIG = require('./config.js');
const {
	HTTP_PORT,
	TWITCH_CHANNEL,
	COLOR_REWARD_ID,
	HUE_BRIDGE_USERNAME,
	HUE_BRIDGE_IP,
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

// Action are being cancelled
let isActionCancelled = false;

// Saved scene
let lastSavedScene = null;

// Function to be called after the scene has been restored
let afterSceneRestore = null;

// Subgifts stack
const subGifts = {};

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
 * Send cancel signal to async actions.
 */
async function cancelActions() {
	isActionCancelled = true;
	enqueueAsyncAction(() => { isActionCancelled = false; });
	await actionQueue;
}

/**
 * Throw error when action signal is set.
 * @throws {string}
 */
function abortOnCancel() {
	if (isActionCancelled) {
		throw 'ABORTED';
	}
}

/**
 * Connect to the Hue bridge and returns the API object.
 * @return {Api}
 */
async function connectHueBridge() {
	let host;
	if (!HUE_BRIDGE_IP) {
		// Find Hue bridge on the LAN
		const foundBridges = await discovery.nupnpSearch();
		host = foundBridges[0].ipaddress;
	} else {
		// Use static IP
		host = HUE_BRIDGE_IP;
	}

	// Connect to the bridge
	hueBridgeApi = await v3.api.createLocal(host).connect(HUE_BRIDGE_USERNAME);

	return hueBridgeApi;
}

/**
 * Set light state
 * @param {int} lightId
 * @param {LightState} lightState
 * @param {int} [transition]
 * @returns {Promise}
 */
async function setLightState(lightId, lightState, transition = null) {
	if (!lightId) {
		(transition !== null) && await delay(transition);
		return;
	}
	if (transition !== null) {
		lightState.transition(transition);
	}
	await hueBridgeApi.lights.setLightState(lightId, lightState);
}

/**
 * Save the current scene.
 */
async function saveScene() {
	// Scene has already been saved
	if (lastSavedScene) {
		return;
	}

	const lightIds = [...LIGHT_IDS].filter(id => !!id);
	if (lightIds.length === 0) {
		return;
	}
	const savedScene = v3.model.createLightScene();
	savedScene.name = SAVED_SCENE_NAME;
	savedScene.lights = lightIds;
	lastSavedScene = await hueBridgeApi.scenes.createScene(savedScene);
}

/**
 * Restore the last scene.
 */
async function restoreScene() {
	if (lastSavedScene) {
		await hueBridgeApi.scenes.activateScene(lastSavedScene.id);
		await hueBridgeApi.scenes.deleteScene(lastSavedScene.id); // We don't need this anymore
		if (afterSceneRestore) {
			await afterSceneRestore();
			afterSceneRestore = null;
		}
		lastSavedScene = null;
	}
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
			promises.push(setLightState(lightId, new LightState().effectNone()));
		}

		// Apply light settings
		promises.push(setLightState(lightId, new LightState().populate(lightSettings), 100));
	}
	await Promise.all(promises);
	console.log(`Resetting lights done.`);
}

/**
 * Perform a test of each light to make sure they are properly configured.
 */
async function lightTest() {
	console.log(`Light test starting...`);
	await saveScene();

	try {
		abortOnCancel();

		// Turn all the lights off
		const promises = [];
		promises.push(setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()));
		promises.push(setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()));
		for (let lightId of LIGHT_IDS) {
			promises.push(setLightState(lightId, new LightState().off(), 0));
		}
		await Promise.all(promises);

		abortOnCancel();

		await delay(1500);

		// Make each light blink
		for (let lightId of LIGHT_IDS) {
			console.log(`Testing ${LIGHT_NAMES[lightId]} with ID ${lightId}...`);
			for (let blink = 1; blink <= 6; blink++) {
				abortOnCancel();
				await setLightState(lightId, new LightState().on().ct(kToCt(6500)).bri(254), 250);
				abortOnCancel();
				await setLightState(lightId, new LightState().off(), 250);
			}
		}

		abortOnCancel();

		await delay(1500);

		abortOnCancel();

		// Restore the previous lights state
		console.log(`Restoring state...`);
		await restoreScene();

		console.log(`Light test complete.`);

	} catch (e) {
		console.log(`Light test stopped: ${e}`);
	}
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

	// Save the current lights state
	await saveScene();

	// Prepare light states
	const offState = new LightState().bri(1);
	const onState = new LightState().bri(254);

	try {
		abortOnCancel();

		// Disable effects and unneeded lights
		await Promise.all([
			setLightState(BACK_LIGHT_ID, new LightState().off(), rate),
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
		]);

		abortOnCancel();

		// Set initial state
		// 0 0
		// 1 1
		await Promise.all([
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().on().rgb(rgb).bri(1), rate),
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().on().rgb(rgb).bri(1), rate),
			setLightState(LEFT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254), rate),
			setLightState(RIGHT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254), rate),
		]);

		// Perform rotating red light effect
		for (let i = 1; i <= num; i++) {

			abortOnCancel();

			// 0 1
			// 0 1
			await Promise.all([
				setLightState(RIGHT_LIGHTSTRIP_ID, onState, rate),
				setLightState(LEFT_KEY_LIGHT_ID, offState, rate),
			]);

			abortOnCancel();

			// 1 1
			// 0 0
			await Promise.all([
				setLightState(LEFT_LIGHTSTRIP_ID, onState, rate),
				setLightState(RIGHT_KEY_LIGHT_ID, offState, rate),
			]);

			abortOnCancel();

			// 1 0
			// 1 0
			await Promise.all([
				setLightState(LEFT_KEY_LIGHT_ID, onState, rate),
				setLightState(RIGHT_LIGHTSTRIP_ID, offState, rate),
			]);

			abortOnCancel();

			// 0 0
			// 1 1
			await Promise.all([
				setLightState(RIGHT_KEY_LIGHT_ID, onState, rate),
				setLightState(LEFT_LIGHTSTRIP_ID, offState, rate),
			]);
		}

		abortOnCancel();

		// Restore previous lights state
		await restoreScene();

		console.log(`Rotating lights effect complete.`);
	} catch (e) {
		console.log(`Rotating lights effect stopped: ${e}`);
	}
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

	// Save the current lights state
	await saveScene();

	try {
		abortOnCancel();

		// Disable effects and unneeded lights
		await Promise.all([
			setLightState(BACK_LIGHT_ID, new LightState().off(), 0),
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
		]);

		abortOnCancel();

		// Set initial state
		// 1 0
		// 1 0
		await Promise.all([
			setLightState(RIGHT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(1), 0),
			setLightState(LEFT_KEY_LIGHT_ID, new LightState().on().ct(ct).bri(254), 0),
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().on().ct(ct).bri(1), 0),
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().on().ct(ct).bri(254), 0),
			delay(rate * 4)
		]);

		// Prepare light states
		const offState = new LightState().bri(1);
		const onState = new LightState().bri(254);

		// Perform rotating red light effect
		for (let i = 1; i <= num; i++) {

			abortOnCancel();

			// 0 1
			// 0 1
			await Promise.all([
				setLightState(LEFT_KEY_LIGHT_ID, offState, 0),
				setLightState(RIGHT_KEY_LIGHT_ID, onState, 0),
				setLightState(LEFT_LIGHTSTRIP_ID, offState, 0),
				setLightState(RIGHT_LIGHTSTRIP_ID, onState, 0),
				delay(rate * 4)
			]);

			abortOnCancel();

			// 1 0
			// 1 0
			await Promise.all([
				setLightState(RIGHT_KEY_LIGHT_ID, offState, 0),
				setLightState(LEFT_KEY_LIGHT_ID, onState, 0),
				setLightState(RIGHT_LIGHTSTRIP_ID, offState, 0),
				setLightState(LEFT_LIGHTSTRIP_ID, onState, 0),
				delay(rate * 4)
			]);
		}

		abortOnCancel();

		// Restore previous lights state
		await restoreScene();

		console.log(`Flashing lights effect complete.`);
	} catch (e) {
		console.log(`Flashing lights effect stopped: ${e}`);
	}
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

	const applyColors = async () => {
		// Set color
		await Promise.all([
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effectNone()),
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effectNone()),
			setLightState(LEFT_LIGHTSTRIP_ID, new LightState().populate({ ...settings[0], effect: 'none' }), COLOR_TRANSITION),
			setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().populate({ ...settings[1], effect: 'none' }), COLOR_TRANSITION),
			delay(COLOR_TRANSITION)
		]);

		// Start effects after the transition ends
		await Promise.all([
			settings[0].effect !== 'none' && setLightState(LEFT_LIGHTSTRIP_ID, new LightState().effect(settings[0].effect)),
			settings[1].effect !== 'none' && setLightState(RIGHT_LIGHTSTRIP_ID, new LightState().effect(settings[1].effect)),
		]);

		console.log(`Color scheme ${schemeName} applied.`);
	};

	if (lastSavedScene) {
		// There is a saved scene: Apply changes after it has been restored
		afterSceneRestore = applyColors;
		console.log(`The color scheme will be applied after the current effect is ended.`);
	} else {
		// Apply changes now
		enqueueAsyncAction(applyColors);
	}
}

/**
 * Push subgifts to the stack.
 * @param {string} username
 * @param {int} [amount=1]
 */
function pushSubGifts(username, amount = 1) {
	if (subGifts[username] === undefined) {
		subGifts[username] = amount;
	} else {
		subGifts[username] += amount;
	}
}

/**
 * Pop a subgift from the stack
 * @param {string} username
 * @return {boolean} true if a subgift count has been popped.
 */
function popSubGift(username) {
	if (subGifts[username] === undefined) {
		return false;
	}
	subGifts[username]--;
	if (subGifts[username] <= 0) {
		delete subGifts[username];
	}
	return true;
}

/**
 * Twitch message handler
 * @param {string} channel
 * @param {object} context
 * @param {string} message
 * @param {boolean} self
 */
function onMessage(channel, context, message, self) {
	// Don't listen to my own messages..
	if (self) return;

	// Only accept commands from broadcaster
	const command = getCommandName(message);
	if (command !== null && context['display-name'] === TWITCH_CHANNEL) {
		const params = message.replace(/[ ]+/, ' ').split(' ').filter(e => e !== `!${command}`);
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
			// Params: username, amount of bits
			case 'bittest':
			case 'bitstest':
			case 'testbit':
			case 'testbits':
			case 'testcheer':
				return onCheer(
					channel,
					{
						'display-name': params[0] || 'Username',
						'bits': parseInt(params[1] || '1', 10)
					},
					''
				);

			// Test subscribe effect
			// Params: username, message
			case 'subtest':
			case 'testsub':
			case 'subscribetest':
			case 'testsubscribe':
				return onSubscription(
					channel,
					params[0] || 'Username',
					{},
					params.splice(1).join(' '),
					{}
				);

			// Test resub effect
			// Params: username, total months, months streak, message
			case 'resubtest':
			case 'testresub':
				return onResub(
					channel,
					params[0] || 'Username',
					parseInt(params[2] || '1', 10),
					params.splice(3).join(' '),
					{
						'msg-param-cumulative-months': params[1] || '1',
						'msg-param-should-share-streak': true
					},
					{}
				);

			// Test sub gift effect
			// Params: username, recipient, months streak
			case 'subgifttest':
			case 'testsubgift':
				return onSubgift(
					channel,
					params[0] || 'Username',
					parseInt(params[2] || '0', 10),
					params[1] || 'Recipient',
					{},
					{}
				);

			// Test sub mystery gift effect
			// Params: username, number of subs
			case 'mysterysubgifttest':
			case 'testmysterysubgift':
			case 'subgiftstest':
			case 'testsubgifts':
				const giver = params[0] || 'Username';
				const numbOfSubs = parseInt(params[1] || '1', 10);
				onSubmysterygift(channel, giver, numbOfSubs, {}, {});
				for (let i = 1; i <= numbOfSubs; i++) {
					onSubgift(channel, giver, '1', `Recipient_${i}`, {}, {});
				}
				return;

			// Test raid effect
			// Params: username, number of viewers
			case 'raidtest':
			case 'testraid':
				return onRaided(
					channel,
					params[0] || 'Username',
					parseInt(params[1] || '666', 10)
				)

			// Test rotating lights effect
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
			case 'testcolor':
			case 'testcolors':
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
}

/**
 * Twitch raided handler
 * @param {string} channel
 * @param {string} username
 * @param {int} viewers
 */
function onRaided(channel, username, viewers) {
	console.log(`${username} raided with ${viewers} viewers.`);
	doRaidEffect();
}

/**
 * Twitch subgift handler
 * @param {string} channel
 * @param {string} username
 * @param {int} streakMonths
 * @param {string} recipient
 * @param {object} methods
 * @param {object} userstate
 */
function onSubgift(channel, username, streakMonths, recipient, methods, userstate) {
	console.log(`${username} gave a subscription to ${recipient}.`);
	if (!popSubGift(username)) {
		doSubscribeEffect();
	}
}

/**
 * Twitch subscription handler
 * @param {string} channel
 * @param {string} username
 * @param {object} method
 * @param {string} message
 * @param {object} userstate
 */
function onSubscription(channel, username, method, message, userstate) {
	console.log(`${username} subscribed to the channel.`);
	doSubscribeEffect();
}

/**
 * Twitch resub handler
 * @param {string} channel
 * @param {string} username
 * @param {int} streakMonths
 * @param {string} message
 * @param {object} userstate
 * @param {object} methods
 */
function onResub(channel, username, streakMonths, message, userstate, methods) {
	let cumulativeMonths = ~~userstate["msg-param-cumulative-months"];
	console.log(`${username} resubscribed to the channel (total months: ${cumulativeMonths}).`);
	doSubscribeEffect();
}

/**
 * Twitch submysterygift handler
 * @param {string} channel
 * @param {string} username
 * @param {int} numbOfSubs
 * @param {object} methods
 * @param {object} userstate
 */
function onSubmysterygift(channel, username, numbOfSubs, methods, userstate) {
	console.log(`${username} gave away ${numbOfSubs} subscriptions.`);
	pushSubGifts(username, numbOfSubs);
	if (numbOfSubs >= 5) {
		doSubGiftEffect();
	} else {
		doSubscribeEffect();
	}
}

/**
 * Twitch cheer handler
 * @param {string} channel
 * @param {object} userstate
 * @param {string} message
 */
function onCheer(channel, userstate, message) {
	console.log(`${userstate['display-name']} cheered with ${userstate.bits} bits.`);
	if (userstate.bits && userstate.bits >= 1000) {
		doBitsEffect();
	}
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
	await resetLights();

	// Instanciate Twitch chat client
	twitchClient = new tmi.Client({ channels: [TWITCH_CHANNEL] });

	// Message handler
	twitchClient.on('message', onMessage);

	// Connect to Twitch chat
	console.log(`Connecting to the Twitch chat...`);
	twitchClient.connect();
	console.log(`Twitch chat connected.`);

	// Start HTTP server, if enabled
	if (HTTP_PORT) {
		const paths = {
			'/raid': doRaidEffect,
			'/subscribe': doSubscribeEffect,
			'/subgift': doSubGiftEffect,
			'/bits': doBitsEffect,
		};

		const server = http.createServer(async (req, res) => {
			if (paths[req.url]) {
				await cancelActions();
				res.statusCode = 200;
				res.setHeader('Content-Type', 'text/plain');
				res.end('ok\n');
				console.log(`Running ${req.url} from HTTP.`);
				paths[req.url]();
			} else {
				res.statusCode = 404;
				res.end('Resource not found\n');
			}
		});

		server.listen(HTTP_PORT, 'localhost', () => {
			console.log(`HTTP server running at http://localhost:${HTTP_PORT}/, not using Twitch events.`);
		});
	} else {

		// Raid handler
		twitchClient.on('raided', onRaided);

		// Subscription handlers
		twitchClient.on('subgift', onSubgift);
		twitchClient.on('subscription', onSubscription);
		twitchClient.on('resub', onResub);
		twitchClient.on('submysterygift', onSubmysterygift);

		// Bits handler
		twitchClient.on('cheer', onCheer);

		console.log(`HTTP server is not running, using direct Twitch events instead.`);
	}
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
