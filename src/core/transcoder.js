const child_process = require('child_process');
const fs = require('fs');
const request = require('request');
const universal = require('./universal');
const pad = require('../utils/pad');
const proxy = require('./proxy');
const rmrf = require('../utils/rmrf');
const sleep = require('../utils/sleep');

class Transcoder {
    constructor(sessionId, req, res, streamOffset, config, websocket) {
        this.alive = true;
        this.ffmpeg = null;
        this.transcoding = true;
        this.sessionId = sessionId;
        this._config = config;
        this._ws = websocket;

        this._init(req, res, streamOffset);
    }

    async _init(req, res, streamOffset) {
        if (req !== void(0) && streamOffset === void(0)) {
            console.log('Create session ' + this.sessionId);
            this.timeout = setTimeout(this.PMSTimeout.bind(this), 20000);

            this.redisClient.on("message", async() => {
                console.log('Callback ' + this.sessionId);
                clearTimeout(this.timeout);
                this.timeout = void(0);

                this.redisClient.unsubscribe("__keyspace@" + this._config.redis_db + "__:" + this.sessionId);
                this._ws.updateKey(this.sessionId + ":last", 0);
                const session = await this._ws.getByKey(this.sessionId);
                this.transcoderStarter(session);
            });

            this.redisClient.subscribe("__keyspace@" + this._config.redis_db + "__:" + this.sessionId);

            if (res != void(0)) {
                proxy(req, res)
            } else {
                this.plexRequest = request(this._config.plex_url + req.url).on('error', (err) => { console.log(err) })
            }
        } else {
            console.log('Restarting session ' + this.sessionId);

            this.streamOffset = streamOffset;

            this._ws.updateKey(this.sessionId + ":last", 0);
            const session = await this._ws.getByKey(this.sessionId);
            this.transcoderStarter(session);
        }
    }

    async transcoderStarter(err, reply) {
        if (err)
            return;

        const keys = await this._ws.getByKeyPattern(this.sessionId + ':*');
        if (keys !== void(0)) {
            keys = keys.filter(k => !k.endsWith("last"));
            if (keys.length > 0) {
                await this._ws.deleteKeys(keys);
            }
        }

        await rmrf(this._config.xdg_cache_home + this.sessionId);
        fs.mkdirSync(this._config.xdg_cache_home + this.sessionId);

        let parsed = JSON.parse(reply);
        if (parsed == null) {
            console.log(reply);
            return;
        }

        this.transcoderArgs = parsed.args.map((arg) => {
            return arg
                .replace('{URL}', "http://127.0.0.1:" + this._config.port)
                .replace('{SEGURL}', "http://127.0.0.1:" + this._config.port)
                .replace('{PROGRESSURL}', this._config.plex_url)
                .replace('{PATH}', this._config.mount_point)
                .replace('{SRTSRV}', this._config.base_url + '/api/sessions')
                .replace(/\{USRPLEX\}/g, this._config.plex_ressources)
        });

        if (this.chunkOffset !== void(0) || this.streamOffset !== void(0))
            this.patchArgs(this.chunkOffset);

        this.transcoderEnv = Object.create(process.env);
        this.transcoderEnv.LD_LIBRARY_PATH = this._config.ld_library_path;
        this.transcoderEnv.FFMPEG_EXTERNAL_LIBS = this._config.ffmpeg_external_libs;
        this.transcoderEnv.XDG_CACHE_HOME = this._config.xdg_cache_home;
        this.transcoderEnv.XDG_DATA_HOME = this._config.xdg_data_home;
        this.transcoderEnv.EAE_ROOT = this._config.eae_root;
        this.transcoderEnv.X_PLEX_TOKEN = parsed.env.X_PLEX_TOKEN;

        this.startFFMPEG();
    }

    startFFMPEG() {
        if (fs.existsSync(this._config.transcoder_path)) {
            console.log('Spawn ' + this.sessionId);
            this.transcoding = true;
            try {
                this.ffmpeg = child_process.spawn(
                    this._config.transcoder_path,
                    this.transcoderArgs,
                    {
                        env: this.transcoderEnv,
                        cwd: this._config.xdg_cache_home + this.sessionId + "/"
                    });
                this.ffmpeg.on("exit", () => {
                    console.log('FFMPEG stopped ' + this.sessionId);
                    this.transcoding = false
                });

                this.updateLastChunk();
            } catch (e) {
                console.log('Failed to start FFMPEG for session ' + this.sessionId);
                console.log(e.toString());
                this.startFFMPEG();
            }
        } else {
            setTimeout(this.startFFMPEG.bind(this), 1000);
        }
    }

    async PMSTimeout() {
        console.log('Timeout ' + this.sessionId);
        this.timeout = void(0);
        await this.killInstance();
    }

    async cleanFiles(fullClean, callback) {
        await rmrf(this._config.xdg_cache_home + this.sessionId);
        const keys = await this._ws.getByKeyPattern(this.sessionId + (fullClean ? '*' : ':*'));
        if ((keys !== void(0)) && keys.length > 0) {
            await this._ws.deleteKeys.del(keys);
        }
        delete universal.cache[this.sessionId];
        callback();
    }

    async killInstance(fullClean = false) {
        console.log('Killing ' + this.sessionId);
        this.alive = false;

        if (this.plexRequest !== void(0)) {
            this.plexRequest.abort();
        }

        if (this.timeout !== void(0)) {
            clearTimeout(this.timeout)
        }

        if (this.sessionTimeout !== void(0)) {
            clearTimeout(this.sessionTimeout)
        }

        if (this.ffmpeg != null && this.transcoding) {
            this.ffmpeg.kill('SIGKILL');
            await sleep(500);
        }
        await this.cleanFiles(fullClean);
    }

    updateLastChunk() {
        let last = 0;
        let prev = null;

        for (let i = 0; i < this.transcoderArgs.length; i++) {
            if (prev == '-segment_start_number' || prev == '-skip_to_segment') {
                last = parseInt(this.transcoderArgs[i]);
                break;
            }
            prev = this.transcoderArgs[i];
        }

        this._ws.updateKey(this.sessionId + ":last", (last > 0 ? last - 1 : last));
    }

    patchArgs(chunkId) {
        if (this.transcoderArgs.includes("chunk-%05d")) {
            console.log('Patching long polling SS');
            this.patchSS(this.streamOffset);
            return;
        }

        console.log('jumping to segment ' + chunkId + ' for ' + this.sessionId);

        let prev = '';
        for (let i = 0; i < this.transcoderArgs.length; i++) {
            if (prev == '-segment_start_number' || prev == '-skip_to_segment') {
                this.transcoderArgs[i] = parseInt(chunkId);
                break;
            }
            prev = this.transcoderArgs[i];
        }

        prev = '';
        let offset = 0;
        let segmentDuration = 5;
        for (let i = 0; i < this.transcoderArgs.length; i++) {
            if (prev == '-segment_time') {
                segmentDuration = this.transcoderArgs[i];
                break;
            }
            if (prev == '-min_seg_duration') {
                offset = -1;
                segmentDuration = this.transcoderArgs[i] / 1000000;
                break;
            }
            prev = this.transcoderArgs[i];
        }

        prev = '';
        for (let i = 0; i < this.transcoderArgs.length; i++) {
            if (prev.toString().startsWith('-force_key_frames')) {
                this.transcoderArgs[i] = 'expr:gte(t,' + (parseInt(chunkId) + offset) * segmentDuration + '+n_forced*' + segmentDuration + ')';
            }
            prev = this.transcoderArgs[i];
        }

        if (this.transcoderArgs.indexOf("-vsync") != -1) {
            this.transcoderArgs.splice(this.transcoderArgs.indexOf("-vsync"), 2)
        }

        this.patchSS((parseInt(chunkId) + offset) * segmentDuration);
    }

    patchSS(time, accurate) {
        let prev = '';
        
        if (this.transcoderArgs.indexOf("-ss") == -1) {
            if (accurate)
                this.transcoderArgs.splice(this.transcoderArgs.indexOf("-i"), 0, "-ss", time, "-noaccurate_seek");
            else
                this.transcoderArgs.splice(this.transcoderArgs.indexOf("-i"), 0, "-ss", time);
        } else {
            prev = '';
            for (let i = 0; i < this.transcoderArgs.length; i++) {
                if (prev == '-ss') {
                    this.transcoderArgs[i] = time;
                    break;
                }
                prev = this.transcoderArgs[i];
            }
        }
    }

    async segmentJumper(chunkId, streamId, callback) {
        try {
            const last = await this._ws.getByKey(this.sessionId + ":last");
            if (last == null || parseInt(last) > parseInt(chunkId) || parseInt(last) < parseInt(chunkId) - 10) {
                throw new Error();
            }
            this.waitChunk(chunkId, streamId, callback);
        }
        catch (e) {
            this._ws.updateKey(this.sessionId + ":last", parseInt(chunkId));

            if (this.ffmpeg != null) {
                this.ffmpeg.removeAllListeners('exit');
                this.ffmpeg.kill('SIGKILL');

                this.patchArgs(chunkId);
                this.startFFMPEG();
            } else {
                this.chunkOffset = parseInt(chunkId);
            }
        }
    }

    async getChunk(chunkId, callback, streamId = '0', noJump = false) {
        const chunk = await this._ws.getByKey(this.sessionId + ":" + streamId + ":" + (chunkId == 'init' ? chunkId : pad(chunkId, 5)));
        if (chunk == null) {
            if (streamId == '0' && noJump == false) {
                await this.segmentJumper(chunkId, streamId, callback);
            }
            else {
                await this.waitChunk(chunkId, streamId, callback);
            }
        } else {
            callback(this.alive ? chunkId : -1);
        }
    }

    async waitChunk(chunkId, streamId, callback) {
        if (this.transcoding) {
            let timeout = setTimeout(() => {
                    redis.end(false);
                    callback(this.alive ? -2 : -1);
                }, 10000);

                redis.on("message", () => {
                clearTimeout(timeout);
                redis.end(false);
                callback(this.alive ? chunkId : -1);
            });
            redis.subscribe("__keyspace@" + this._config.redis_db + "__:" + this.sessionId + ":" + streamId + ":" + (chunkId == 'init' ? chunkId : pad(chunkId, 5)))
        } else {
            callback(-1);
        }
    }
}

module.exports = Transcoder;
