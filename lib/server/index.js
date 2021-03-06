var fs = require('fs'),
    path = require('path');

var clients = {};

module.exports = function(responderId, config, ss) {
  var name = config && config.name || 'model';
  var pollFreq = config && config.pollFreq || 1000;

  ss.client.send('mod','ssAngular', loadFile('ssAngular.js')); //angular integrations
  ss.client.send('mod', 'synced-model', loadFile('client.js'));
  ss.client.send('code', 'init', "require('synced-model')("+responderId+", {}, require('socketstream').send("+responderId+"));");

  return {
    name: name,
    interfaces: function(middleware) {
      var model = require('./model')(ss,middleware);

      return {
        websocket: function(msg, meta, send) {
          msg = JSON.parse(msg);

          var req = {
            method: msg.m,
            modelName: msg.n,
            params: msg.p,
            socketId: meta.socketId,
            clientIp: meta.clientIp,
            sessionId: meta.sessionId,
            transport: meta.transport,
            receivedAt: Date.now()
          };

          if(req.params) {
            try {
              req.paramString = JSON.stringify(req.params);
            }
            catch(e)
            {
              throw new Error("Params not in JSON form!", e);
            }
          }
          else {
            req.paramString = "*";
          }

          req.requestName = req.modelName + "/" + req.paramString;

          var msgLogName = ("model:" + req.requestName).grey;

          var handleError = function(e) {
            var message;
            if(meta.clientIp === '127.0.0.1') {
              message = e.stack;
            }
            else {
              message = 'See server-side logs';
            }

            var obj = {e: {message: message}};
            ss.log("<-".red, msgLogName, req.method, req.requestName, e);
            if(e.stack) {
              ss.log(e.stack.split("\n").splice(1).join("\n"));
            }
            send(JSON.stringify(obj));
          };

          if(req.method === 'LINK') {
            try {
              if(clients[req.socketId]) { //client already exists
                if(clients[req.socketId][req.requestName]) { //already syncing model
                  throw new Error("Duplicate request" + JSON.stringify(req));
                }
              }
              else {
                clients[req.socketId] = {};
              }

              var client = clients[req.socketId];
              var socket;

              var updateModel = function() {
                model(req, function(err, modelObj) {
                  if(err) {
                    try {
                      stopPolling(req.socketId,req.requestName);
                    }
                    catch(e) {
                      ss.log('Error and could not stop polling'.red, e);
                    }
                    handleError(err);
                  }
                  else {
                    var responseObj;
                    if(!modelObj) {
                      var error = 'NOAUTH';
                      ss.log(msgLogName, error.red);
                      responseObj = {
                        r: error,
                        o: modelObj,
                        n: req.requestName
                      };
                      try {
                        stopPolling(req.socketId,req.requestName);
                      }
                      catch(e) {
                        handleError(e);
                      }
                    }
                    else {
                      responseObj = {
                        r: "OK",
                        o: modelObj,
                        n: req.requestName
                      };
                    }
                    socket = send(JSON.stringify(responseObj));
                  }
                });
              };

              client[req.requestName] = setInterval(function() {
                if(socket && socket.disconnected) {
                  ss.log(msgLogName,'Client Disconnected. Stopping updates'.yellow);
                  stopPolling(req.socketId, req.requestName);
                  return;
                }
                updateModel();
              }, pollFreq);

              var res = {};
              res.m = req.method;
              res.r = "OK";
              res.i = "Subscribed to model";
              ss.log("<-".green,res.r.green,msgLogName,res.i);
              send(JSON.stringify(res));

              process.nextTick(function() {
                updateModel();
              });
            }
            catch(e) {
              try {
                stopPolling(req.socketId,req.requestName);
              }
              catch(e) {
                ss.log(msgLogName, "Could not stop polling in an error case. Not always a problem: ", e);
              }
              handleError(e);
            }
          }
          else if(req.method === "UNLINK") {
            try {
              stopPolling(req.socketId,req.requestName);
            } 
            catch(e) {
              handlError(e);
              return;
            }
            var res = {};
            res.m = req.method;
            res.r = "OK";
            res.i = "Unsubscribed from model";
            res.n = req.requestName;
            send(JSON.stringify(res));
            ss.log("<-".green,res.r.green,msgLogName,res.i);
          }
          else {
            handleError("Invalid method");
          }
        }
      };
    }
  };
};

var loadFile = function(name) {
  var fileName = path.join(__dirname, '../client', name);
  return fs.readFileSync(fileName, 'utf8');
};

var stopPolling = function(clientId,model) {
  if(!clients) {
    throw new Error("No clients");
  }
  var client = clients[clientId];
  if(!client) {
    throw new Error("No such client");
  }
  var intervalId = client[model];
  if(!intervalId) {
    throw new Error("No interval id for client/model");
  }
  clearInterval(intervalId);
  delete clients[clientId][model]
};
