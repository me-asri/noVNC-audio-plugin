#!/bin/sh
# shellcheck shell=dash

readonly SCRIPT="$0"

readonly PULSE_PORT='4711'
readonly PULSE_FORMAT='s16le'
readonly PULSE_SAMPLE_RATE='48000'
readonly PULSE_CHANNELS='2'

readonly TCP_BIND='127.0.0.1'

print_usage() {
	echo "Usage: ${SCRIPT} [OPTION]..."
	echo "Audio proxy meant to be put behind Websockify to provide audio to NoVNC audio plugin"
	echo
	echo 'Options:'
	echo " -p <port>        : raw audio source port (default: ${PULSE_PORT})"
	echo ' -l <port>        : listen for clients on specified TCP port'
	echo " -b <host>        : bind TCP listener to specified host (default: ${TCP_BIND})"
	echo ' -u <path>        : listen for clients on specified Unix socket path'
	echo ' -s <path>        : secret file path (note: this does NOT provide any kind of encryption)'
	echo " -f <format>      : raw audio source format (default: ${PULSE_FORMAT})"
	echo " -r <sample rate> : raw audio source sample rate (default: ${PULSE_SAMPLE_RATE})"
	echo " -c <channels>    : raw audio source channel count (default: ${PULSE_CHANNELS})"
}

error() {
	echo "$1" >&2
	exit 1
}

usage_error() {
	echo "$1" >&2
	print_usage >&2

	exit 1
}

proto_ready() {
	echo "READY"
}

proto_error() {
	echo "ERR:$1"
	exit 1
}

aac_proxy() {
	local pulse_port="$1"
	local pulse_format="$2"
	local pulse_sample_rate="$3"
	local pulse_channels="$4"

	local bitrate="$5"
	local sample_rate="$6"

	proto_ready

	exec gst-launch-1.0 -q mp4mux streamable=true fragment-duration=10 name=mux ! fdsink fd=1 \
		tcpclientsrc port="${pulse_port}" ! queue ! rawaudioparse use-sink-caps=false format=pcm pcm-format="${pulse_format}" sample-rate="${pulse_sample_rate}" num-channels="${pulse_channels}" \
		! audioconvert ! audioresample ! audio/x-raw, rate="${sample_rate}" ! fdkaacenc afterburner=true bitrate="${bitrate}" ! mux.audio_0
}

opus_proxy() {
	local pulse_port="$1"
	local pulse_format="$2"
	local pulse_sample_rate="$3"
	local pulse_channels="$4"

	local bitrate="$5"

	proto_ready

	exec gst-launch-1.0 -q webmmux name=mux ! fdsink fd=1 \
		tcpclientsrc port="${pulse_port}" ! rawaudioparse use-sink-caps=false format=pcm pcm-format="${pulse_format}" sample-rate="${pulse_sample_rate}" num-channels="${pulse_channels}" \
		! audioconvert ! audioresample ! opusenc bitrate="${bitrate}" bitrate-type=0 complexity=4 frame-size=10 ! mux.audio_0
}

proxy() {
	local pulse_port="$1"
	local pulse_format="$2"
	local pulse_sample_rate="$3"
	local pulse_channels="$4"

	local secret_file="$5"

	# Default to Opus
	local codec='opus'
	local bitrate='96000'
	local sample_rate='48000'

	local secret

	local line
	while IFS= read -r line; do
		if [ -z "${line}" ]; then
			break
		fi

		case "${line}" in
		*':'*) ;;
		*)
			proto_error 'bad handshake' ;;
		esac
		local opt
		opt="$(echo "${line}" | cut -d ':' -f 1)"
		local val
		val="$(echo "${line}" | cut -d ':' -f 2-)"

		case "${opt}" in
		'CD')
			codec="${val}" ;;
		'BR')
			bitrate="${val}" ;;
		'SR')
			sample_rate="${val}" ;;
		'SEC')
			secret="${val}" ;;
		*)
			proto_error "invalid option ${opt}" ;;
		esac
	done

	if [ -n "${secret_file}" ]; then
		if [ "${secret}" != "$(cat "${secret_file}")" ]; then
			proto_error 'bad secret'
		fi
	fi

	case "${codec}" in
	'opus')
		opus_proxy "${pulse_port}" "${pulse_format}" "${pulse_sample_rate}" "${pulse_channels}" "${bitrate}" ;;
	'aac')
		aac_proxy "${pulse_port}" "${pulse_format}" "${pulse_sample_rate}" "${pulse_channels}" "${bitrate}" "${sample_rate}" ;;
	*)
		proto_error "invalid codec ${codec}";
	esac
}

server() {
	local pulse_port="${PULSE_PORT}"
	local pulse_format="${PULSE_FORMAT}"
	local pulse_sample_rate="${PULSE_SAMPLE_RATE}"
	local pulse_channels="${PULSE_CHANNELS}"

	local secret_file

	local tcp_port
	local tcp_bind="${TCP_BIND}"

	local unix_socket

	while getopts 'p:l:b:u:s:f:r:c:h' opt; do
		case "${opt}" in
		'p')
			pulse_port="${OPTARG}"
		;;
		'l')
			tcp_port="${OPTARG}"
		;;
		'b')
			tcp_bind="${OPTARG}"
		;;
		'u')
			unix_socket="${OPTARG}"
		;;
		's')
			secret_file="${OPTARG}"
		;;
		'f')
			pulse_format="${OPTARG}"
		;;
		'r')
			pulse_sample_rate="${OPTARG}"
		;;
		'c')
			pulse_channels="${OPTARG}"
		;;
		'h')
			print_usage
			exit 0
		;;
		*)
			print_usage
			exit 1
		;;
		esac
	done
	shift $((OPTIND - 1))

	if [ -z "${tcp_port}" ] && [ -z "${unix_socket}" ]; then
		usage_error 'At least a listening TCP port or Unix socket is required'
	fi
	if [ -n "${tcp_port}" ] && [ -n "${unix_socket}" ]; then
		usage_error '-u and -l options are mutually exclusive'
	fi

	echo "Raw source port: ${pulse_port}"
	echo "Raw source format: ${pulse_format}"
	echo "Raw source sample rate: ${pulse_sample_rate}"
	echo "Raw source channels: ${pulse_channels}"

	local proxy_cmd="${SCRIPT} proxy ${pulse_port} ${pulse_format} ${pulse_sample_rate} ${pulse_channels} ${secret_file}"
	if [ -n "${tcp_port}" ]; then
		echo "Server listening on ${tcp_bind}:${tcp_port}"
		exec socat tcp-listen:"${tcp_port}",bind="${tcp_bind}",nodelay,reuseaddr,fork exec:"${proxy_cmd}",nofork
	elif [ -n "${unix_socket}" ]; then
		echo "Server listening on '${unix_socket}'"
		exec socat unix-listen:"${unix_socket}",fork exec:"${proxy_cmd}",nofork
	fi
}

if ! command -v socat  >/dev/null 2>&1; then
	error 'socat not found. Is it installed?'
fi
if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
	error 'GStreamer (gst-launch-1.0) not found. Is it installed?'
fi

if [ "$1" = 'proxy' ]; then
	shift
	proxy "$@"
else
	server "$@"
fi
