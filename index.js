'use strict'
var valid = require('muxrpc-validation')({})
var crypto = require('crypto')
var ssbKeys = require('ssb-keys')
var cont = require('cont')
var explain = require('explain-error')
var ip = require('ip')
var mdm = require('mdmanifest')
var fs = require('fs')
var ref = require('ssb-ref')
var level = require('level')
var sublevel = require('level-sublevel/bytewise')
var path = require('path')

var createClient = require('ssb-client/client')

// invite plugin
// adds methods for producing invite-codes,
// which peers can use to command your server to follow them.

function isFunction (f) {
  return 'function' === typeof f
}

function isString (s) {
  return 'string' === typeof s
}

function isObject(o) {
  return o && 'object' === typeof o
}

function isNumber(n) {
  return 'number' === typeof n && !isNaN(n)
}

module.exports = {
  name: 'invite',
  version: '1.0.0',
  manifest: require('./manifest.json'),
  permissions: {
    master: {allow: ['create']},
    //temp: {allow: ['use']}
  },
  init: function (server, config) {
    var codes = {}, codesDB
    if(server.sublevel)
      codesDB = server.sublevel('codes')
    else {
      var db = sublevel(level(path.join(config.path, 'db'), {
        valueEncoding: 'json'
      }))
      codesDB = db.sublevel('codes')
    }
    //add an auth hook.
    server.auth.hook(function (fn, args) {
      var pubkey = args[0], cb = args[1]

      // run normal authentication
      fn(pubkey, function (err, auth) {
        if(err || auth) return cb(err, auth)

        // if no rights were already defined for this pubkey
        // check if the pubkey is one of our invite codes
        codesDB.get(pubkey, function (_, code) {
          //disallow if this invite has already been used.
          if(code && (code.used >= code.total)) cb()
          else cb(null, code && code.permissions)
        })
      })
    })

    function getInviteAddress () {
      return (config.allowPrivate
        ? server.getAddress('public') || server.getAddress('local') || server.getAddress('private')
        : server.getAddress('public')
        )
    }

    return {
      create: valid.async(function (opts, cb) {
        opts = opts || {}
        if(isNumber(opts))
          opts = {uses: opts}
        else if(isObject(opts)) {
          if(opts.modern)
            opts.uses = 1
        }
        else if(isFunction(opts))
          cb = opts, opts = {}

        var addr = getInviteAddress()
        if(!addr) return cb(new Error(
          'no address available for creating an invite,'+
          'configuration needed for server.\n'+
          'see: https://github.com/ssbc/ssb-config/#connections'
        ))
        addr = addr.split(';').shift()
        var host = ref.parseAddress(addr).host
        if(typeof host !== 'string') {
          return cb(new Error('Could not parse host portion from server address:' + addr))
        }

        if (opts.external)
          host = opts.external

        if(!config.allowPrivate && (ip.isPrivate(host) || 'localhost' === host || host === ''))
          return cb(new Error('Server has no public ip address, '
                            + 'cannot create useable invitation'))

        //this stuff is SECURITY CRITICAL
        //so it should be moved into the main app.
        //there should be something that restricts what
        //permissions the plugin can create also:
        //it should be able to diminish it's own permissions.

        // generate a key-seed and its key
        var seed = crypto.randomBytes(32)
        var keyCap = ssbKeys.generate('ed25519', seed)

        // store metadata under the generated pubkey
        var owner = server.id
        codesDB.put(keyCap.id,  {
          id: keyCap.id,
          total: +opts.uses || 1,
          note: opts.note,
          used: 0,
          permissions: {allow: ['invite.use', 'getAddress'], deny: null}
        }, function (err) {
          // emit the invite code: our server address, plus the key-seed
          if(err) cb(err)
          else if(opts.modern) {
            var ws_addr = getInviteAddress().split(';').sort(function (a, b) {
               return +/^ws/.test(b) - +/^ws/.test(a)
            }).shift()


            if(!/^ws/.test(ws_addr)) throw new Error('not a ws address:'+ws_addr)
            cb(null, ws_addr+':'+seed.toString('base64'))
          }
          else {
            addr = ref.parseAddress(addr)
            cb(null, [opts.external ? opts.external : addr.host, addr.port, addr.key].join(':') + '~' + seed.toString('base64'))
          }
        })
      }, 'number|object', 'string?'),
      use: valid.async(function (req, cb) {
        var rpc = this

        // fetch the code
        codesDB.get(rpc.id, function(err, invite) {
          if(err) return cb(err)

          // check if we're already following them
          server.friends.get(function (err, follows) {
//          server.friends.all('follow', function(err, follows) {
//            if(hops[req.feed] == 1)
            if (follows && follows[server.id] && follows[server.id][req.feed])
              return cb(new Error('already following'))

            // although we already know the current feed
            // it's included so that request cannot be replayed.
            if(!req.feed)
              return cb(new Error('feed to follow is missing'))

            if(invite.used >= invite.total)
              return cb(new Error('invite has expired'))

            invite.used ++

            //never allow this to be used again
            if(invite.used >= invite.total) {
              invite.permissions = {allow: [], deny: null}
            }
            //TODO
            //okay so there is a small race condition here
            //if people use a code massively in parallel
            //then it may not be counted correctly...
            //this is not a big enough deal to fix though.
            //-dominic

            // update code metadata
            codesDB.put(rpc.id, invite, function (err) {
              server.emit('log:info', ['invite', rpc.id, 'use', req])

              // follow the user
              server.publish({
                type: 'contact',
                contact: req.feed,
                following: true,
                pub: true,
                note: invite.note || undefined
              }, cb)
            })
          })
        })
      }, 'object'),
      accept: valid.async(function (invite, cb) {
        // remove surrounding quotes, if found
        if(isObject(invite))
          invite = invite.invite

        if (invite.charAt(0) === '"' && invite.charAt(invite.length - 1) === '"')
          invite = invite.slice(1, -1)
        var opts
        // connect to the address in the invite code
        // using a keypair generated from the key-seed in the invite code
        var modern = false
        if(ref.isInvite(invite)) { //legacy ivite
          if(ref.isLegacyInvite(invite)) {
            var parts = invite.split('~')
            opts = ref.parseAddress(parts[0])//.split(':')
            //convert legacy code to multiserver invite code.
            var protocol = 'net:'
            if (opts.host.endsWith(".onion"))
              protocol = 'onion:'
            invite = protocol+opts.host+':'+opts.port+'~shs:'+opts.key.slice(1, -8)+':'+parts[1]
          }
          else
            modern = true
        }

        opts = ref.parseAddress(ref.parseInvite(invite).remote)
        function connect (cb) {
          createClient({
            keys: true, //use seed from invite instead.
            remote: invite,
            config: config,
            manifest: {invite: {use: 'async'}, getAddress: 'async'}
          }, cb)
        }

        // retry 3 times, with timeouts.
        // This is an UGLY hack to get the test/invite.js to pass
        // it's a race condition, I think because the server isn't ready
        // when it connects?

        function retry (fn, cb) {
          var n = 0
          ;(function next () {
            var start = Date.now()
            fn(function (err, value) {
              n++
              if(n >= 3) cb(err, value)
              else if(err) setTimeout(next, 500 + (Date.now()-start)*n)
              else cb(null, value)
            })
          })()
        }

        retry(connect, function (err, rpc) {

          if(err) return cb(explain(err, 'could not connect to server'))

          // command the peer to follow me
          rpc.invite.use({ feed: server.id }, function (err, msg) {
            if(err) return cb(explain(err, 'invite not accepted'))

            // follow and announce the pub
            cont.para([
              cont(server.publish)({
                type: 'contact',
                following: true,
                autofollow: true,
                contact: opts.key
              }),
              (
                opts.host
                ? cont(server.publish)({
                    type: 'pub',
                    address: opts
                  })
                : function (cb) { cb() }
              )
            ])
            (function (err, results) {
              if(err) return cb(err)
              rpc.close()
                rpc.close()
                //ignore err if this is new style invite
                if(server.gossip) server.gossip.add(ref.parseInvite(invite).remote, 'seed')
                cb(null, results)
            })
          })
        })
      }, 'string')
    }
  }
}

