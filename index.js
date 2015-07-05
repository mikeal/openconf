var http = require('http')
  , response = require('response')
  , fs = require('fs')
  , path = require('path')
  , body = require('body/any')
  , level = require('level')
  , url = require('url')
  , sublevel = require('level-sublevel')
  , index = require('level-index')
  , eachy = require('eachy')
  , uuid = require('node-uuid')
  , flatten = require('flatten')
  , phone = require('phone')
  , qs = require('querystring')
  , request = require('request').defaults({headers:{'user-agent':'openconf-0.0.1'}})
  , router = require('http-hash-router')()

  , db = level(path.join(__dirname, 'db'), {valueEncoding:'json'})
  , levelSession = require('level-session')({db:db})

  , host = 'conf.tenconf.com'
  , urlbase = 'http://conf.tenconf.com/'
  , config =
    { accountSid: process.env.TWILIO_SID
    , authToken: process.env.TWILIO_TOKEN
    , twilioNumber: '+12017318489'
    , port: process.env.PORT || 80
    }
  , client = require('twilio')(config.accountSid, config.authToken)
  ;

var tokens = sublevel(db).sublevel('tokens')
  , confs = sublevel(db).sublevel('confs')
  , contacts = sublevel(db).sublevel('contacts')
  ;

function reindex () {
  confs.createReadStream().on('data', function (doc) {
    confs.put(doc.id, doc, console.log)
  })
}

var byOrg = index(confs,
    'byOrg',
    function (key, value, emit) {
      var obj = value;
      if (!obj.org) return
      emit(obj.org, { id : key, })
    }
)

function docsByKeys (db, index, keys, cb) {
  eachy(
  keys,
  function (key, cb) {
    var ids = []
    index.createReadStream({start:key, end: key})
    .on('data', function (obj) {
      ids.push(obj.value.id)
    })
    .on('end', function () {
      cb(null, ids)
    })
  },
  function (err, ids) {
    ids = flatten(ids)
    function _get (id, cb) {
      db.get(id, function (err, obj) {
        if (err) return cb(null)
        cb(err, obj)
      })
    }
    eachy(ids, _get, cb)
  })
}

function scheduler (dt, obj, cb) {
  var now = Date.now()
    , future = dt.getTime()
    ;
  return setTimeout(function () {cb(obj)}, future - now)
}

var timeouts = {}
function callConference (id) {
  confs.get(id, function (err, doc) {
    if (err || !doc.rsvp) return console.error('issue w/ doc', id)
    eachy(
    doc.rsvp,
    function (user, cb) {
      contacts.get(user.login, function (err, contact) {
        if (err) return cb(null)
        cb(null, contact)
      })
    },
    function (err, contacts) {
      if (err) return console.error('unresolvable error w/', id)
      contacts = contacts.filter(function (c) {return c})
      contacts.push('+14159925092')
      contacts.forEach(function (contact) {
        console.log('calling', contact)
        var url = 'http://conf.tenconf.com/conf/'+doc.id
        client.makeCall(
          { to: contact
          , from: config.twilioNumber
          , url: url
          },
        function(err, message) {
          console.log('call', err, message)
        })
      })
    })
  })
}
function onConference (conf) {
  var conf = conf.value
  var dt = new Date(conf.dt)
  if (dt.getTime() < Date.now()) return
  if (timeouts[conf.id]) clearTimeout(timeouts[conf.id])
  timeouts[conf.id] = scheduler(dt, conf.id, callConference)
}
confs.createReadStream()
.on('data', onConference)
.on('end', function () {
  confs.post(function (ch) {
    onConference(ch)
  })
})

callConference('57579f10-22c5-11e5-a3c7-6feea46ce6bd')

router.set('/', function (req, res) {
  levelSession(req, res, function () {
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

function conferenceTemplate (doc) {
  var ret =
  '<Response>' +
    '<Say>Joining conference now.</Say>' +
    '<Dial>' +
        '<Conference ' +
        'record="record-from-start" ' +
        'eventCallbackUrl="http://conf.tenconf.com/conf-end/'+doc.id+'">'+doc.id+'</Conference>' +
    '</Dial>' +
  '</Response>'
  return ret
}

router.set('/conf/:id', function (req, res, opts) {
  body(req, function (err, data) {
    confs.get(opts.params.id, function (err, doc) {
      console.log('confsdb', err, doc)
      if (err) return response.error(404).pipe(res)
      console.log(conferenceTemplate(doc))
      response.xml(conferenceTemplate(doc)).pipe(res)
    })
  })
})
router.set('/conf-end/:id', function (req, res, opts) {
  body(req, function (err, data) {
    console.log(data)
    if (err) return response.error(err).pipe(res)
    confs.get(opts.params.id, function (err, doc) {
      if (err) return response.error(404).pipe(res)
      // TODO - write to soundcloud
    })
  })
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
    request(u, function (e, resp, body) {
      if (e) return response.error(e).pipe(res)
      if (resp.statusCode !== 200) {
        return response.error(new Error('statusCode not 200, '+resp.statusCode))
      }
      var token = qs.parse(body)
        , opts = {json:true}
        ;
      request('https://api.github.com/user?access_token='+token.access_token, opts, function (e, r, body) {
        if (e) return response.error(e).pipe(res)
        if (r.statusCode !== 200) {
          return response.error(new Error('statusCode not 200, '+resp.statusCode)).pipe(res)
        }
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
      var user = body.user

      contacts.get(user.login, function (err, phone) {
        var u = 'https://api.github.com/user/orgs?access_token='+body.access_token
        request(u, {json:true}, function (err, r, body) {
          if (err) return response.error(err).pipe(res)
          if (r.statusCode !== 200) {
            return response.error(new Error('statusCode not 200, '+r.statusCode)).pipe(res)
          }
          var orgs = body.map(function (obj) {return obj.login})
          var count = 0

          docsByKeys(confs, byOrg, orgs, function (err, _confs) {
            response.json({confs:_confs, orgs:orgs, phone:phone, user:user}).pipe(res)
          })

        })
      })
    })
  })
})
router.set('/create', function (req, res) {
  body(req, function (err, data) {
    if (err) return response.error(err).pipe(res)
    levelSession(req, res, function () {
      req.session.get('token', function (err, body) {
        if (err) return response.error(err).pipe(res)
        if (!body) {
          return response.json({error:'not logged in'}).pipe(res)
        }
        data.user = body.user
        data.id = uuid.v1()
        confs.put(data.id, data, function (err) {
          if (err) return response.error(err).pipe(res)
          return response.json(data).pipe(res)
        })
      })
    })
  })
})
router.set('/rsvp', function (req, res) {
  body(req, function (err, data) {
    if (err) return response.error(err).pipe(res)
    levelSession(req, res, function () {
      req.session.get('token', function (err, token) {
        if (err) return response.error(err).pipe(res)
        if (!token) {
          return response.json({error:'not logged in'}).pipe(res)
        }
        confs.get(data.id, function (err, doc) {
          if (!doc.rsvp) doc.rsvp = []
          // console.log(token.user)
          // console.log(doc.rsvp)
          for (var i=0;i<doc.rsvp.length;i++) {
            if (token.user.login === doc.rsvp[i].login) return response.json({error:"Already RSVP'd."}).pipe(res)
          }
          doc.rsvp.push(token.user)

          confs.put(doc.id, doc, function (err, info) {
            if (err) return response.error(err).pipe(res)
            response.json(info).pipe(res)
          })
        })
      })
    })
  })
})
router.set('/set-contact', function (req, res) {
  body(req, function (err, data) {
    if (err) return response.error(err).pipe(res)

    var num = phone(data)
    if (!num[0]) return response.json({error:'number is not valid.'}).pipe(res)

    levelSession(req, res, function () {
      req.session.get('token', function (err, token) {
        if (err) return response.error(err).pipe(res)
        contacts.put(token.user.login, num[0], function (err, info) {
          if (err) return response.error(err).pipe(res)
          res.statusCode = 201
          res.end()
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
  console.log(req.method, req.url)
  router(req, res, {}, function (err) {
    return response.error(err).pipe(res)
  })
}).listen(config.port, function () {
  console.log('http://conf.tenconf.com:'+config.port)
})
