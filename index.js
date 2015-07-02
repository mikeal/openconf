var http = require('http')
  , response = require('response')
  , fs = require('fs')
  , path = require('path')
  , body = require('body/any')
  , level = require('level')
  , url = require('url')
  , sublevel = require('level-sublevel')
  , indexer = require('level-sec')
  , eachy = require('eachy')

  , qs = require('querystring')
  , request = require('request').defaults({headers:{'user-agent':'openconf-0.0.1'}})

  , db = level(path.join(__dirname, 'db'), {valueEncoding:'json'})
  , levelSession = require('level-session')({db:db})

  , host = 'conf.tenconf.com'

  , urlbase = 'http://conf.tenconf.com/'

  , config = {
    // Twilio Account SID - found on your dashboard
    accountSid: process.env.TWILIO_SID,

    // Twilio Auth Token - found on your dashboard
    authToken: process.env.TWILIO_TOKEN,

    // A Twilio number that you have purchased through the twilio.com web
    // interface or API
    twilioNumber: '+12017318489',

    // The port your web application will run on
    port: process.env.PORT || 80
  }

var router = require('http-hash-router')()

router.set('/', function (req, res) {
  levelSession(req, res, function () {
    console.log(req.session.token)
    var f = fs.createReadStream(path.join(__dirname, 'index.html'))
    return f.pipe(response.html()).pipe(res)
  })
})

router.set('/call', function (req, res) {
  body(req, function (err, data) {
    if (err) return response(err).pipe(res)
    var url = ''
    client.makeCall(
      { to: request.body.phoneNumber
      , from: config.twilioNumber
      , url: url
      },
    function(err, message) {
      var txt = 'Thank you! We will be calling you shortly.'
      if (err) return response.error(err).pipe(res)
      else return response.json({message: txt}).pipe(res)
    })
  })
})

var tokens = sublevel(db).sublevel('tokens')
  , confs = sublevel(db).sublevel('confs')
  , indexes = indexer(confs)
    .by('org')
    .by('owner')
    .db
  ;

confs.createReadStream().on('data', function (obj) {
  console.log(obj)
})

router.set('/outbound', function (req, res) {
  var xml =
  '<Response>' +
    '<Say voice="alice">' +
      'Thanks for calling.' +
    '</Say>' +
    '<Dial>+16515551111</Dial>' +
  '</Response>'
  return response.xml(xml).pipe(res)
})

router.set('/intl-tel-input/*', function (req, res) {
  var f = req.url.slice('/intl-tel-input'.length)
    , p = path.join(__dirname, 'node_modules', 'intl-tel-input', 'build', f)
    ;
  return fs.createReadStream(p).pipe(response()).pipe(res)
})

router.set('/login', function (req, res) {
  var options =
    { client_id: process.env.GH_CID
    , redirect_uri: urlbase + 'callback'
    , scope: 'read:org'
    , state: Math.random().toString()
    }
  res.setHeader('location', 'https://github.com/login/oauth/authorize?'+qs.stringify(options))
  res.statusCode = 302
  res.end()
})
router.set('/callback', function (req, res) {
  levelSession(req, res, function () {
    var post = qs.parse(url.parse(req.url).query)
      , opts =
        { client_id: process.env.GH_CID
        , client_secret: process.env.GH_SECRET
        , code: post.code
        }
      , u = 'https://github.com/login/oauth/access_token?'+qs.stringify(opts)
      ;
    console.log(opts)
    request(u, function (e, resp, body) {
      if (e) return response.error(e).pipe(res)
      if (resp.statusCode !== 200) {
        return response.error(new Error('statusCode not 200, '+resp.statusCode))
      }
      var token = qs.parse(body)
        , opts = {json:true}
        ;
      console.log(opts)
      request('https://api.github.com/user?access_token='+token.access_token, opts, function (e, r, body) {
        if (e) return response.error(e).pipe(res)
        if (r.statusCode !== 200) {
          return response.error(new Error('statusCode not 200, '+resp.statusCode)).pipe(res)
        }
        console.log(body)
        token.user = body
        req.session.set('token', token, function (err) {
          if (err) return response.error(err).pipe(res)
          res.statusCode = 302
          res.setHeader('location', '/')
          res.end()
        })
      })
    })
  })
})

router.set('/list', function (req, res) {
  levelSession(req, res, function () {
    req.session.get('token', function (err, body) {
      if (err) return response.error(err).pipe(res)
      if (!body) {
        return response.json({error:'not logged in'}).pipe(res)
      }
      var u = 'https://api.github.com/user/orgs?access_token='+body.access_token
      request(u, {json:true}, function (err, r, body) {
        if (err) return response.error(err).pipe(res)
        if (r.statusCode !== 200) {
          return response.error(new Error('statusCode not 200, '+r.statusCode)).pipe(res)
        }
        var orgs = body.map(function (obj) {return obj.login})
        var count = 0

        orgs.forEach(function (org) {
          var confs = []
          indexes.byorg.get(org, function (err, _confs) {
            if (!err) confs = confs.concat(_confs)
            count = count + 1
            if (count === orgs.length) {
              response.json({confs:confs, orgs:orgs}).pipe(res)
            }
          })
        })
      })
    })
  })
})
router.set('/signout', function (req, res) {
  levelSession(req, res, function () {
    req.session.delAll(function () {
      res.statusCode = 302
      res.setHeader('location', '/')
      res.end()
    })
  })
})

router.set('/static/*', function (req, res) {
  var f = req.url.slice('/static'.length)
    , p = path.join(__dirname, 'static', f)
    ;
  return fs.createReadStream(p).pipe(response()).pipe(res)
})

http.createServer(function (req, res) {
  router(req, res, {}, function (err) {
    return response.error(err).pipe(res)
  })
}).listen(config.port, function () {
  console.log('http://conf.tenconf.com:'+config.port)
})
