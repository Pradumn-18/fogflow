const mqtt = require('mqtt');
const websocket = require('websocket-stream');
const CryptoJS = require('crypto-js');
const moment = require('moment');

/**
 * utilities to do sigv4
 * @class SigV4Utils
 */
function SigV4Utils(){}

SigV4Utils.sign = function(key, msg){
  var hash = CryptoJS.HmacSHA256(msg, key);
  return hash.toString(CryptoJS.enc.Hex);
};

SigV4Utils.sha256 = function(msg) {
  var hash = CryptoJS.SHA256(msg);
  return hash.toString(CryptoJS.enc.Hex);
};

SigV4Utils.getSignatureKey = function(key, dateStamp, regionName, serviceName) {
  var kDate = CryptoJS.HmacSHA256(dateStamp, 'AWS4' + key);
  var kRegion = CryptoJS.HmacSHA256(regionName, kDate);
  var kService = CryptoJS.HmacSHA256(serviceName, kRegion);
  var kSigning = CryptoJS.HmacSHA256('aws4_request', kService);
  return kSigning;
};

/**
  * AWS IOT MQTT Client
  * @class MQTTClient
  * @param {Object} options - the client options
  * @param {string} options.endpoint
  * @param {string} options.regionName
  * @param {string} options.accessKey
  * @param {string} options.secretKey
  * @param {string} options.clientId
  * @param {string} options.sessionToken
  */
function MQTTClient(options) {
  this.options = options;

  this.clientId = options.clientId;
  this.name = this.clientId + '@' + options.endpoint;
  this.connected = false;

  this.listeners = {};

  this.client = this.connect(options);

  this.client.on('connect', () => {
    this.connected = true;
    console.log('connected');
    this.emit('onConnect');
  });

  this.client.on('reconnect', () => {
    console.log('reconnect');
  });

  this.client.on('close', () => {
    console.log('close');
    this.emit('onConnectionLost');
  });

  this.client.on('offline', () => {
    console.log('offline');
  });

  this.client.on('message', (topic, message) => {
    var obj = {
      clientId: this.clientId,
      topic: topic,
      message: message
    };
    this.emit('onMessageArrived', obj);
  });

}

MQTTClient.prototype.connect = function () {

  var client = new mqtt.MqttClient(() => {
    var url = this.computeUrl();
    
    console.log(url);
    
    return websocket(url, ['mqttv3.1']);
  });

  return client;
};

/**
* listen to client event, supported events are connected, connectionLost,
* messageArrived(event parameter is of type Paho.MQTT.Message), publishFailed,
* subscribeSucess and subscribeFailed
* @method     MQTTClient#on
* @param      {string}  event
* @param      {Function}  handler
*/
MQTTClient.prototype.on = function (event, handler) {
  if (!this.listeners[event]) {
    this.listeners[event] = [];
  }
  this.listeners[event].push(handler);
};

/** emit event
 *
 * @method MQTTClient#emit
 * @param {string}  event
 * @param {any} args - event parameters
 */
MQTTClient.prototype.emit = function (event) {
  var listeners = this.listeners[event];
  if (listeners) {
    var args = Array.prototype.slice.apply(arguments, [1]);
    for (var i = 0; i < listeners.length; i++) {
      var listener = listeners[i];
      listener.apply(null, args);
    }
  }
};

/**
 * disconnect
 * @method MQTTClient#disconnect
 */
MQTTClient.prototype.disconnect = function () {
  console.log('Disconnect');
  this.client.end();
};

/**
 * publish a message
 * @method     MQTTClient#publish
 * @param      {string}  topic
 * @param      {string}  payload
 */
MQTTClient.prototype.publish = function (topic, payload) {
  try {
    var payloadStr = JSON.stringify(payload);
    this.client.publish(topic, payloadStr);
  } catch(e) {
    throw e;
  }
};

/**
 * subscribe to a topic
 * @method     MQTTClient#subscribe
 * @param      {string}  topic
 */
MQTTClient.prototype.subscribe = function (topic) {
  this.client.subscribe(topic, (err, granted) => {
    if (err) {
      console.log('Failed to subscribe');
      this.emit('onSubFailure');
      return;
    }
    console.log('Successfully subscribe');
    this.emit('onSubSuccess');
  });
};

/**
 * compute the url for websocket connection
 * @private
 *
 * @method     MQTTClient#computeUrl
 * @return     {string}  the websocket url
 */
MQTTClient.prototype.computeUrl = function(){
  // must use utc time
  var time = moment.utc();
  var dateStamp = time.format('YYYYMMDD');
  var amzdate = dateStamp + 'T' + time.format('HHmmss') + 'Z';
  var service = 'iotdevicegateway';
  var region = this.options.regionName;
  var secretKey = this.options.secretKey;
  var accessKey = this.options.accessKey;
  var algorithm = 'AWS4-HMAC-SHA256';
  var method = 'GET';
  var canonicalUri = '/mqtt';
  var host = this.options.endpoint.toLowerCase();

  var credentialScope = dateStamp + '/' + region + '/' + service + '/' + 'aws4_request';
  var canonicalQuerystring = 'X-Amz-Algorithm=AWS4-HMAC-SHA256';
  canonicalQuerystring += '&X-Amz-Credential=' + encodeURIComponent(accessKey + '/' + credentialScope);
  canonicalQuerystring += '&X-Amz-Date=' + amzdate;
  canonicalQuerystring += '&X-Amz-Expires=86400';
  canonicalQuerystring += '&X-Amz-SignedHeaders=host';

  var canonicalHeaders = 'host:' + host + '\n';
  var payloadHash = SigV4Utils.sha256('');
  var canonicalRequest = method + '\n' + canonicalUri + '\n' + canonicalQuerystring + '\n' + canonicalHeaders + '\nhost\n' + payloadHash;

  var stringToSign = algorithm + '\n' +  amzdate + '\n' +  credentialScope + '\n' +  SigV4Utils.sha256(canonicalRequest);
  var signingKey = SigV4Utils.getSignatureKey(secretKey, dateStamp, region, service);
  var signature = SigV4Utils.sign(signingKey, stringToSign);

  canonicalQuerystring += '&X-Amz-Signature=' + signature;
  var requestUrl = 'wss://' + host + canonicalUri + '?' + canonicalQuerystring;
  return requestUrl;
};

module.exports.MQTTClient = MQTTClient;
