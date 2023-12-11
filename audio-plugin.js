/**
 * Audio plugin for NoVNC
 * A drop-in plugin for out-of-band audio playback
 * 
 * Copyright (C) 2023 Mehrzad Asri
 * Licensed under MPL 2.0
 */

import NVUI from "./app/ui.js";

// Helper class for using MediaSource with data segments
class MediaSourcePlayer {
    static BUFFER_MIN_REMAIN = 30;

    mediaSource;
    sourceBuffer;

    #directFeed = true; // First data is always fed directly
    #dataQueue = [];

    #attachedEl;

    constructor(mime) {
        this.mediaSource = new MediaSource();

        this.mediaSource.addEventListener('sourceopen', () => {
            // See https://developer.mozilla.org/en-US/docs/Web/Media/Formats/codecs_parameter for more
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);

            // Playback media segments in the same order they are inserted in
            this.sourceBuffer.mode = 'sequence';

            this.sourceBuffer.addEventListener('updateend', () => {
                // Stop here if for whatever reason the source buffer is still updating
                if (this.sourceBuffer.updating) {
                    return;
                }

                // Do a direct feed next time if queue is empty
                if (this.#dataQueue.length == 0) {
                    this.#directFeed = true;
                    return;
                }

                // Get next data from queue and add it to the source buffer
                const data = this.#dataQueue[0];

                try {
                    this.sourceBuffer.appendBuffer(data);
                    this.#dataQueue.shift();
                } catch (err) {
                    // If quota full, drop some of buffer
                    // See https://developer.chrome.com/blog/quotaexceedederror
                    if (err.name == 'QuotaExceededError') {
                        console.log('SourceBuffer quota exceeded. Emptying buffer.');

                        const bufferEnd = this.sourceBuffer.buffered.end(0);
                        const removeEnd = bufferEnd - MediaSourcePlayer.BUFFER_MIN_REMAIN;

                        this.sourceBuffer.remove(0, (removeEnd <= 0) ? 1 : removeEnd);
                        if (!this.sourceBuffer.updating) {
                            this.sourceBuffer.appendBuffer(data);
                            this.#dataQueue.shift();
                        }
                        return;
                    }
                    else {
                        throw err;
                    }
                }
            });
        }, { once: true });
    }

    async attach(element) {
        if (this.#attachedEl) {
            throw new Error('Already attached to an element');
        }

        element.src = URL.createObjectURL(this.mediaSource);
        element.addEventListener('play', MediaSourcePlayer.playEventHandler);
        this.#attachedEl = element;

        return new Promise((resolve) => {
            this.mediaSource.addEventListener('sourceopen', () => {
                resolve();
            }, { once: true });
        });
    }

    async detach() {
        if (this.#attachedEl) {
            this.#attachedEl.removeEventListener('play', MediaSourcePlayer.playEventHandler);

            await this.#attachedEl.pause();
            this.#attachedEl.removeAttribute('src');
            this.#attachedEl.currentTime = 0;
        }
    }

    feed(data) {
        if (!this.#attachedEl) {
            throw new Error('Not attached to any elements');
        }
        if (this.mediaSource.readyState != 'open') {
            throw new Error(`Bad MediaSource state: ${this.mediaSource.readyState}`);
        }

        // Feed directly if direct feed is enabled otherwise queue data
        if (this.#directFeed) {
            this.sourceBuffer.appendBuffer(data);

            // Disable direct feed if source buffer is updating
            if (this.sourceBuffer.updating) {
                this.#directFeed = false;
            }
        } else {
            this.#dataQueue.push(data);
        }
    }

    static playEventHandler(event) {
        const audioEl = event.target;

        // Make sure we're always playing the live edge of the stream
        // Mostly necessary if some external entity decided to pause the media
        if (audioEl.seekable.length > 0) {
            audioEl.currentTime = audioEl.seekable.end(0);
        }
    }
}

// Helper functions for interacting with the NoVNC UI
const NV = {
    optionEls: [],

    getMainSettingsList() {
        return document.querySelector('#noVNC_settings ul');
    },

    addSubCategory(parent, label) {
        const settingsItem = document.createElement('li');

        const expanderDiv = document.createElement('div');
        expanderDiv.classList.add('noVNC_expander');
        expanderDiv.innerHTML = label;

        expanderDiv.addEventListener('click', NVUI.toggleExpander);

        const childDiv = document.createElement('div');

        const listDiv = document.createElement('ul');
        childDiv.appendChild(listDiv);

        settingsItem.appendChild(expanderDiv);
        settingsItem.appendChild(childDiv);

        parent.appendChild(settingsItem);

        return listDiv;
    },

    addInput(settingsList, label, name, defaultVal = null, type = 'text', title = null) {
        const settingItem = document.createElement('li');

        const settingLabel = document.createElement('label');

        const settingInput = document.createElement('input');
        settingInput.id = `noVNC_setting_${name}`;
        settingInput.type = type;

        if (title) {
            settingLabel.title = title;
            settingInput.title = title;
        }

        settingItem.appendChild(settingLabel);
        if (type == 'checkbox') {
            settingLabel.appendChild(settingInput);
        } else {
            settingLabel.htmlFor = settingInput.id;
            settingItem.appendChild(settingInput);
        }
        settingLabel.appendChild(document.createTextNode(label));

        settingInput.addEventListener('change', () => NVUI.saveSetting(name));

        settingsList.appendChild(settingItem);

        NVUI.initSetting(name, defaultVal);

        this.optionEls.push(settingInput);
        return settingInput;
    },

    addDropdown(settingsList, label, name, values, defaultVal = null, title = null) {
        const settingItem = document.createElement('li');

        const settingLabel = document.createElement('label');
        settingLabel.innerText = label;

        const settingSelect = document.createElement('select');
        settingSelect.id = `noVNC_setting_${name}`;
        settingLabel.htmlFor = settingSelect.id;

        if (title) {
            settingLabel.title = title;
            settingSelect.title = title;
        }

        settingItem.appendChild(settingLabel);
        settingItem.appendChild(settingSelect);

        settingSelect.addEventListener('change', () => NVUI.saveSetting(name));

        for (const [name, val] of Object.entries(values)) {
            const option = document.createElement('option');
            option.text = name;
            option.value = val;

            settingSelect.appendChild(option);
        }

        settingsList.appendChild(settingItem);

        NVUI.initSetting(name, defaultVal);

        this.optionEls.push(settingSelect);
        return settingSelect;
    },

    addLineBreak(settingsList) {
        const settingItem = document.createElement('li');

        const lineBreak = document.createElement('hr');
        settingItem.appendChild(lineBreak);

        settingsList.appendChild(settingItem);

        return lineBreak;
    },

    observeState(state, callback, once = false) {
        const doc = document.documentElement;

        const observer = new MutationObserver(async () => {
            if ((state == 'disconnected' && doc.classList.length == 0)
                || doc.classList.contains(`noVNC_${state}`)) {
                await callback(observer);

                if (once) {
                    observer.disconnect();
                }
            }
        });
        observer.observe(doc, { attributes: true, attributeFilter: ['class'] });
    },

    disableOptions(disable = true) {
        for (const optionEl of this.optionEls) {
            optionEl.disabled = disable;
        }
    }
};

// Helper functions for the audio proxy
const AudioProxy = {
    handshake(socket, codec = 'opus', bitrate = 96000, sampleRate = 48000, secret = null) {
        const textEnc = new TextEncoder();
        const textDec = new TextDecoder();

        let handshakeMsg = `CD:${codec}\nBR:${bitrate}\nSR:${sampleRate}\n\n`;
        if (secret != null) {
            handshakeMsg += `sec:${secret}`;
        }
        handshakeMsg += `\n`;
        socket.send(textEnc.encode(handshakeMsg));

        return new Promise((resolve) => {
            socket.addEventListener('message', (msg) => {
                const resp = textDec.decode(msg.data).trim();
                if (resp == 'READY') {
                    resolve();
                } else if (resp.startsWith('ERR:')) {
                    throw new Error(`Proxy error: ${resp.substring(4)}`);
                } else {
                    throw new Error('Protocol error');
                }
            }, { once: true });
        });
    }
};

const AudioPlugin = {
    msp: null,
    ws: null,
    audioEl: null,

    async onClickPlayHandler() {
        try {
            await this.audioEl.play();
        } catch (err) {
            if (err.name != 'AbortError') {
                NVUI.showStatus(`Audio playback failed: ${err.message}`, 'error');
            }
            await this.stopAudio();
        }
    },

    async startAudio() {
        if (this.msp) {
            return;
        }

        const codec = NVUI.getSetting('audio_codec');
        const bitrate = NVUI.getSetting('audio_bitrate');
        const samplerate = NVUI.getSetting('audio_samplerate');
        let mime;
        switch (codec) {
            case 'opus':
                mime = 'audio/webm; codecs="opus"';
                break;
            case 'aac':
                mime = 'audio/mp4; codecs="mp4a.40.2"';
                break;
            default:
                throw new Error(`Unsupported codec ${codec}`);
        }

        const wsSchema = (NVUI.getSetting('audio_encrypt')) ? 'wss://' : 'ws://';
        const wsHost = NVUI.getSetting('audio_host');
        const wsPort = NVUI.getSetting('audio_port');
        const wsPath = NVUI.getSetting('audio_path');

        this.ws = new WebSocket(`${wsSchema}${wsHost}:${wsPort}/${wsPath}`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.addEventListener('error', async () => {
            if (NVUI.connected) {
                NVUI.showStatus('Audio WebSocket connection failed', 'error');
            }
            await this.stopAudio();
        });
        this.ws.addEventListener('close', async () => {
            if (!this.msp) {
                return;
            }

            if (NVUI.connected) {
                NVUI.showStatus('Audio WebSocket connection closed', 'error');
            }
            await this.stopAudio();
        });

        this.ws.addEventListener('open', async () => {
            try {
                this.msp = new MediaSourcePlayer(mime);
                await this.msp.attach(this.audioEl);
            } catch (err) {
                NVUI.showStatus(`MediaSource initialization failed: ${err.message}`);

                await this.stopAudio();
                return;
            }

            try {
                await AudioProxy.handshake(this.ws, codec, bitrate, samplerate);
            } catch (err) {
                NVUI.showStatus(`Audio handshake failed: ${err.message}`, 'error');

                await this.stopAudio();
                return;
            }

            this.ws.addEventListener('message', async (msg) => {
                try {
                    this.msp.feed(msg.data);
                } catch (err) {
                    NVUI.showStatus(`Audio failure: ${err.message}`, 'error');

                    await this.stopAudio();
                    return;
                }
            });

            // Start playing audio on user click
            // Necessary because most if not all browsers prevent autoplay
            document.body.addEventListener('click', async () => this.onClickPlayHandler(), { capture: true, once: true });
        });
    },

    async stopAudio() {
        if (this.msp) {
            await this.msp.detach();
            this.msp = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    },

    initUi() {
        // == Audio element ==
        this.audioEl = document.createElement('audio');
        this.audioEl.id = 'noVNC_audio';

        document.body.appendChild(this.audioEl);

        // == Audio settings menu ==
        const settingsList = NV.getMainSettingsList();

        NV.addLineBreak(settingsList);

        const audioSettings = NV.addSubCategory(settingsList, 'Audio Plugin');
        NV.addInput(audioSettings, 'Enabled', 'audio_enabled', false, 'checkbox', 'Enable audio plugin');

        NV.addLineBreak(audioSettings);

        NV.addDropdown(audioSettings, 'Codec:', 'audio_codec', {
            'WebM/Opus': 'opus',
            'MP4/AAC': 'aac'
        }, MediaSource.isTypeSupported('audio/webm; codecs="opus"') ? 'opus' : 'aac', 'Audio codec');
        NV.addDropdown(audioSettings, 'Bitrate:', 'audio_bitrate', {
            '64kbps': '64000',
            '96kbps': '96000',
            '128kbps': '128000',
            '192kbps': '192000'
        }, '96000', 'Audio bitrate');
        NV.addDropdown(audioSettings, 'Sample Rate:', 'audio_samplerate', {
            '44.1kHz': '44100',
            '48kHz': '48000',
        }, '48000', 'Audio sample rate\nNote: Opus always outputs 48kHz');

        NV.addLineBreak(audioSettings);

        NV.addInput(audioSettings, 'Secret:', 'audio_secret', null, 'password', 'Optional connection secret\nNote: this does NOT provide encryption');

        const audioWsSettings = NV.addSubCategory(audioSettings, 'WebSocket');
        NV.addInput(audioWsSettings, 'Encrypt', 'audio_encrypt', NVUI.getSetting('encrypt'), 'checkbox',
            'Use encrypted WebSocket connection');
        NV.addInput(audioWsSettings, 'Host:', 'audio_host', NVUI.getSetting('host'), 'text',
            'WebSocket host for audio proxy');
        NV.addInput(audioWsSettings, "Port:", 'audio_port', NVUI.getSetting('port'), 'text',
            'WebSocket port for audio proxy');
        NV.addInput(audioWsSettings, "Path:", 'audio_path', 'websockify?token=audio', 'text',
            'WebSocket path for audio proxy');
    },

    load() {
        this.initUi();

        // Start audio after VNC connection
        NV.observeState('connected', async () => {
            if (!NVUI.getSetting('audio_enabled')) {
                return;
            }
            NV.disableOptions();

            try {
                await this.startAudio();
            } catch (err) {
                NVUI.showStatus(`Audio setup failed: ${err.message}`, 'error');
            }
        });

        // Stop audio after VNC disconnection
        NV.observeState('disconnected', async () => {
            await this.stopAudio();
            NV.disableOptions(false);
        });
    }
};

window.addEventListener('load', () => AudioPlugin.load());