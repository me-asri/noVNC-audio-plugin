# Audio plugin for NoVNC

## Description

__NoVNC__ drop-in plugin for out-of-band audio playback.

Tested with [__NoVNC 1.4.0__](https://github.com/novnc/noVNC/releases/tag/v1.4.0)

## Features

* Low-latency real-time audio playback using __WebSocket__ and __Media Source API__.
* Works with both __PipeWire__ and __PulseAudio__.
* No WebRTC shenanigans necessary.

## Installation

<details>
<summary><h3>NoVNC</h3></summary>

* Copy [__audio-plugin.js__](audio-plugin.js) to the NoVNC client directory where `vnc.html` is located.

* Add the following line to the end of the `head` section of [`vnc.html`](https://github.com/novnc/noVNC/blob/master/vnc.html#L48).

    ```html
    <script type="module" crossorigin="anonymous" src="audio-plugin.js"></script>
    ```

> `vnc_lite.html` is not supported yet.

</details>

<details>
<summary><h3>Host</h3></summary>

VNC protocol in general only handles graphics and not audio. Audio must be transmitted to out-of-band using a separate connection.

#### PulseAudio/PipeWire

A few modifications to the configuration of PulseAudio/PipeWire is necessary to allow capturing audio and feeding it to the __Audio Proxy__.

* If using __PulseAudio__:

    Enable __`module-simple-protocol-tcp`__ module on PulseAudio: 

    ```console
    # echo "load-module module-simple-protocol-tcp listen=127.0.0.1 format=s16le channels=2 rate=48000 record=true playback=false" > /etc/pulse/default.pa.d/simple-protocol.pa
    $ pulseaudio -k
    $ pulseaudio --start
    ```

* If using __PipeWire__:

    Enable __`libpipewire-module-protocol-simple`__ module on PipeWire:

    ```
    # cat > /etc/pipewire/pipewire.conf.d/simple-protocol.conf << EOF
    context.modules = [
        {
            name = libpipewire-module-protocol-simple
            args = {
                capture = true
                playback = false

                stream.capture.sink = true

                audio.rate = 48000
                audio.format = S16LE
                audio.channels = 2

                server.address = [
                    "tcp:127.0.0.1:4711"
                ]
            }
        }
    ]
    EOF
    $ systemctl --user restart pipewire
    ```

#### Audio Proxy

Raw audio output from PulseAudio must be encoded to a codec supported by Media Source (e.g. WebM/Opus) before it can be played back on the browser.

[audio-proxy.sh](audio-proxy.sh) shell script can encode raw audio to the required format using [GStreamer](https://gstreamer.freedesktop.org/).

```console
$ audio-proxy.sh -l 5711
Raw source port: 4711
Raw source format: s16le
Raw source sample rate: 48000
Raw source channels: 2
Server listening on 127.0.0.1:5711
```

> __audio-proxy.sh__ requires __socat__ and __gstreamer-tools__ (along with _Base_, _Good_ and _Bad_ plugins) to be installed on your system.
>
> * Installing dependencies on Ubuntu/Debian:
>
> ```console
> $ apt install socat gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
> ```
>
> * Installing dependencies on Alpine Linux:
>
> ```console
> $ apk add socat gstreamer-tools gst-plugins-base gst-plugins-good gst-plugins-bad
> ```

#### Websockify

Just like VNC, __Audio Proxy__ only accepts raw TCP connections. [__Websockify__](https://github.com/novnc/websockify) will take care of proxying WebSocket traffic to and from __audio-proxy.sh__.

It's possible to proxy both VNC and Audio and serve the NoVNC client files using a single __Websockify__ instance.

Assuming
* there's a __VNC server__ running on port `5900` 
* __Audio Proxy__ running on port `5711`
* __noVNC__ client files are located at `/var/www/noVNC`

__Websockify__ can be configured like this:

```console
# cat > /etc/websockify/token.cfg << EOF
	vnc: 127.0.0.1:5900
	audio: 127.0.0.1:5711
EOF
$ websockify \
    --web=/var/www/noVNC \
    --token-plugin=TokenFile \
    --token-source=/etc/websockify/token.cfg \
    8080
```

* NoVNC client will now be accessible at http://localhost:8080
* VNC WebSocket path will be `websockify?token=vnc`
* Audio WebSocket path will be `websockify?token=audio`

</details>

## Known Issues

* Audio may not start playing if autoconnect is enabled.

## TODO

- [ ] Add support for Windows
- [ ] Add builtin WebSocket server to __Audio Proxy__

## Disclaimer

This is an experimental and hacky piece of software, so expect a few bugs here and there.

Make sure to use TLS with proper HTTP authentication if this software is being exposed to the internet.

</details>