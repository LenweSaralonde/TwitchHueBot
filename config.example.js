module.exports = {
	// HTTP server port to trigger effects externally (optional)
	HTTP_PORT: null, // ie 666

	// Twitch channel name
	TWITCH_CHANNEL: 'MyTwitchChannel',

	// ID of the Twitch reward used to change the Lightstrip colors
	COLOR_REWARD_ID: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',

	// Username on the Hue bridge
	HUE_BRIDGE_USERNAME: 'XXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXXXXX',

	// Hue bridge IP (optional)
	HUE_BRIDGE_IP: null, // ie '192.168.0.100'

	// Key light IDs (as seen by the camera)
	LEFT_KEY_LIGHT_ID: 1,
	RIGHT_KEY_LIGHT_ID: 2,

	// Back light ID
	BACK_LIGHT_ID: 3,

	// RGB Lightstrip IDs (as seen by the camera)
	LEFT_LIGHTSTRIP_ID: 4,
	RIGHT_LIGHTSTRIP_ID: 5,

	// Initial light settings
	INITIAL_LIGHT_SETTINGS: {
		LEFT_KEY_LIGHT_ID: { on: true, bri: 254, k: 6500 },
		RIGHT_KEY_LIGHT_ID: { on: true, bri: 254, k: 6500 },
		BACK_LIGHT_ID: { on: true, bri: 254, k: 6500 },
		LEFT_LIGHTSTRIP_ID: { on: true, bri: 254, colormode: 'xy', xy: [0.3659, 0.1506] },
		RIGHT_LIGHTSTRIP_ID: { on: true, bri: 254, colormode: 'xy', xy: [0.1559, 0.1521] },
	},

	// Color schemes
	COLOR_SCHEMES: [
		{
			keywords: ['red'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.6833, 0.3092] },
			],
		},
		{
			keywords: ['green'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.17, 0.7] },
			],
		},
		{
			keywords: ['blue'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.1532, 0.0475] },
			],
		},
		{
			keywords: ['yellow'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.3615, 0.5561] },
			],
		},
		{
			keywords: ['pink'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.3448, 0.2793] },
			],
		},
		{
			keywords: ['purple', 'violet'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.246, 0.0934] },
			],
		},
		{
			keywords: ['orange'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.4868, 0.462] },
			],
		},
		{
			keywords: ['white'],
			settings: [
				{ on: true, bri: 254, colormode: 'ct', ct: 153 },
			],
		},
		{
			keywords: ['gold'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.4544, 0.4611] },
			],
		},
		{
			keywords: ['rgb', 'rainbow', 'pride', 'gay', 'lgbt'],
			settings: [
				{ on: true, bri: 254, sat: 254, hue: 0, effect: 'colorloop' },
				{ on: true, bri: 254, sat: 254, hue: 32767, effect: 'colorloop' },
			],
		},
		{
			keywords: ['cyberpunk'],
			settings: [
				{ on: true, bri: 254, colormode: 'xy', xy: [0.3659, 0.1506] },
				{ on: true, bri: 254, colormode: 'xy', xy: [0.1559, 0.1521] },
			],
		},
	],

	// Transition duration for color change
	COLOR_TRANSITION: 1000,
};