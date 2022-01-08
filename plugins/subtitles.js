var http = require('http');
var fs = require('fs');
var path = require('path');
var srt2vtt = require('srt2vtt');
var internalIp = require('internal-ip');
var debug = require('debug')('castnow:subtitles');
var got = require('got');

var Transcoder = require('stream-transcoder');
var noop = function() {};

var srtToVtt = function(options, cb) {
  var source = options.subtitles;
  var handler = fs.existsSync(source) ? fs.readFile : got;
  var encoder = options['bypass-srt-encoding'] ? srt2vtt.raw : srt2vtt;
  handler(source, function(err, content) {
    if (err) return cb(err);
    if (!isSrt(source)) return cb(null, content);
    encoder(content, function(err, data) {
      if (err) return cb(err);
      debug('converted srt to vtt: %s', source);
      cb(null, data);
    });
  });
};

var findSubtitles = function(options, next) {
  if (options.subtitles || !options.playlist[0].media || !options.playlist[0].media.metadata || !options.playlist[0].media.metadata.filePath) return next();

  var videoPath = options.playlist[0].media.metadata.filePath;
  var videoBaseName = path.basename(videoPath, path.extname(videoPath));
  var mediaFolder = path.dirname(videoPath);
  var srtPath = path.join(mediaFolder, videoBaseName + '.srt');

  if (fs.existsSync(srtPath)) {
    debug('subtitles found in %s', srtPath);
    options.subtitles = srtPath;
    return next();
  }

  debug('checking metadata for subtitles');
  new Transcoder(videoPath)
    .once('error', noop)
    .once('metadata', function(meta) {
      if (!meta.input.streams) return next();
      var sub = meta.input.streams.find(it => it.type === 'subtitle');
      if (!sub) return next();

      extractSubtitles(options, next);
    }).exec();
}

var isSrt = function(path) {
  return path.substr(-4).toLowerCase() === '.srt';
};

var extractSubtitles = function(options, next) {
  var videoPath = options.playlist[0].media.metadata.filePath;

  var trans = new Transcoder(videoPath)
    .custom('vn')
    .custom('an')
    .custom('codec', 'srt')
    .custom('map', '0')
    .on('finish', function() {
      debug('finished subtitle extract');
      options.subtitles = srtFile;
      return next();
    })
    .on('error', function(err) {
      debug('subtitle extract error: %o', err);
      return next();
    });

  var srtFile = `/tmp/castnow_pid${process.pid}_subtitles.srt`;
  trans.writeToFile(srtFile);
};

var attachSubtitles = function(ctx) {
  if (!ctx.options.playlist[0].media) {
    ctx.options.playlist[0].media = {};
  }
  ctx.options.playlist[0].media.textTrackStyle = {
    backgroundColor: '#00000000',
    foregroundColor: ctx.options['subtitle-color'] || '#FFFF00FF',
    edgeType: 'OUTLINE',
    edgeColor: '#000000FF',
    fontScale: ctx.options['subtitle-scale'],
    fontStyle: 'NORMAL',
    fontFamily: 'Droid Sans',
    fontGenericFamily: 'SANS_SERIF',
    windowColor: '#AA00FFFF',
    windowRoundedCornerRadius: 10,
    windowType: 'NONE'
  };
  ctx.options.playlist[0].media.tracks = [{
    trackId: 1,
    type: 'TEXT',
    trackContentId: ctx.options.subtitles,
    trackContentType: 'text/vtt',
    name: 'English',
    language: 'en-US',
    subtype: 'SUBTITLES'
  }];
  ctx.options.playlist[0].activeTrackIds = [1];
};

/*
** Handles subtitles, the process is the following:
**  - Is there a media defined ?
**  - Is there subtitles in the command line ?
**  - Is there rightly named subtitles in the the same folder as the video files ?
**  - Are those subtitles stored locally (.srt) or on a distant server (.vtt) ?
**  - If they are stored locally we need to convert and serve them via http.
*/
var subtitles = function(ctx, next) {
  if (ctx.mode !== 'launch') return next();
  if (ctx.options.playlist.length > 1) return next();

  findSubtitles(ctx.options, function() {
    if (!ctx.options.subtitles) return next();

    var port = ctx.options['subtitle-port'] || 4101;
    srtToVtt(ctx.options, function(err, data) {
      if (err) return next();
      debug('loading subtitles', ctx.options.subtitles);
      if (err) return next();
      var ip = ctx.options.myip || internalIp.v4.sync();
      var addr = 'http://' + ip + ':' + port;
      http.createServer(function(req, res) {
        debug('incoming request');
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Length': data.length,
          'Content-type': 'text/vtt;charset=utf-8'
        });
        res.end(data);
      }).listen(port);
      debug('started webserver on address %s using port %s', ip, port);
      ctx.options.subtitles = addr;
      attachSubtitles(ctx);
      next();
    });
  });
};

module.exports = subtitles;
