'use strict';

const NGSIClient = require('./ngsi/ngsiclient.js');
const NGSIAgent = require('./ngsi/ngsiagent.js');
const fogfunction = require('./function.js');

var fs = require('fs');

var ngsi10client = null;
var brokerURL;
var output = {};
var input = {};
var threshold = 30;
var myReferenceURL;
var mySubscriptionId = null;
var isConfigured = false;

function startApp() {
    console.log('start to receive input data streams via a listening port');
}

function stopApp() {
    console.log('clean up the app');
}

// handle the commands received from the engine
function handleAdmin(req, commands, res) {
    console.log('=============configuration commands=============');
    console.log(commands);

    handleCmds(commands);

    isConfigured = true;

    res.status(200).json({});
}

function handleCmds(commands) {
    for (var i = 0; i < commands.length; i++) {
        var cmd = commands[i];
        console.log(cmd);
        handleCmd(cmd);
        console.log("handle next command");
    }
}

function handleCmd(commandObj) {
    if (commandObj.command == 'CONNECT_BROKER') {
        connectBroker(commandObj);
    } else if (commandObj.command == 'SET_INPUTS') {
        setInputs(commandObj);
    } else if (commandObj.command == 'SET_OUTPUTS') {
        setOutputs(commandObj);
    } else if (commandObj.command == 'SET_REFERENCE') {
        setReferenceURL(commandObj);
    }
}

// connect to the IoT Broker
function connectBroker(cmd) {
    brokerURL = cmd.brokerURL;
    ngsi10client = new NGSIClient.NGSI10Client(brokerURL);
    console.log('connected to broker', cmd.brokerURL);
}

function setReferenceURL(cmd) {
    myReferenceURL = cmd.url
    console.log('your application can subscribe addtional inputs under the reference URL: ', myReferenceURL);
}

function setInputs(cmd) {
    input.id = cmd.id;
    input.type = cmd.type;
    console.log('input has been set: ', cmd);
}


function setOutputs(cmd) {
    output.id = cmd.id;
    output.type = cmd.type;

    console.log('output has been set: ', output);
}

//
// query results from the assigned nearby IoT broker
//
function query(queryCtxReq, f) {
    if (ngsi10client == null) {
        console.log("=== broker is not configured for your query");
        return
    }

    ngsi10client.queryContext(queryCtxReq).then(f).catch(function(error) {
        console.log('failed to query context');
    });
}

//
// send subscriptions to IoT broker
//
function subscribe(subscribeCtxReq) {
    if (ngsi10client == null) {
        console.log("=== broker is not configured for your subscription");
        return
    }

    subscribeCtxReq.reference = myReferenceURL;

    console.log("================trigger my own subscription===================");
    console.log(subscribeCtxReq);

    ngsi10client.subscribeContext(subscribeCtxReq).then(function(subscriptionId) {
        console.log("subscription id = " + subscriptionId);
        mySubscriptionId = subscriptionId;
    }).catch(function(error) {
        console.log('failed to subscribe context');
    });
}

//
// publish context entities: 
//
function publish(ctxUpdate) {
    if (ngsi10client == null) {
        console.log("=== broker is not configured for your update");
        return
    }

    // if the output has been set, use the configured entity id and type
    if ('id' in output && 'type' in output) {
        ctxUpdate.entityId = {};
        ctxUpdate.entityId.id = output.id;
        ctxUpdate.entityId.type = output.type;
        ctxUpdate.entityId.isPattern = false;
    }

    console.log(ctxUpdate);

    ngsi10client.updateContext(ctxUpdate).then(function(data) {
        console.log('======send update======');
        console.log(data);
    }).catch(function(error) {
        console.log(error);
        console.log('failed to update context');
    });
}

// handle the received results
function handleNotify(req, ctxObjects, res) {
    console.log('============handle notify==========================');
    for (var i = 0; i < ctxObjects.length; i++) {
        console.log(ctxObjects[i]);
        try {
            fogfunction.handler(ctxObjects[i], publish, query, subscribe);
        } catch (error) {
            console.log(error)
        }
    }
}

async function fetchInputByQuery() {
    // fetch the input entities via a query
    var queryReq = {}

    if (input.type != null) {
        queryReq.entities = [{ type: input.type, isPattern: true }];
    } else if (input.id != null) {
        queryReq.entities = [{ id: input.id, isPattern: false }];
    }

    return await axios({
        method: 'post',
        url: brokerURL + '/queryContext',
        data: queryReq
    }).then(function(response) {
        if (response.status == 200) {
            var objectList = [];
            var ctxElements = response.data.contextResponses;
            for (var i = 0; ctxElements && i < ctxElements.length; i++) {
                console.log(ctxElements[i].contextElement)
                var obj = NGSIClient.CtxElement2JSONObject(ctxElements[i].contextElement);
                objectList.push(obj);
            }
            return objectList;
        } else {
            return null;
        }
    });
}

// one time execution triggered by query
function query2execution() {
    (async function() {
        try {
            // receive the query result
            let ctxObjects = await fetchInputByQuery();

            // call the customized function to generate the analytics result
            for (var i = 0; i < ctxObjects.length; i++) {
                fogfunction.handler(ctxObjects[i], publish, query, subscribe);
            }
        } catch (e) {
            console.log(e)
        }
    })();
}

// continuous execution to handle received notifications
function notify2execution() {
    // get the listening port number from the environment variables given by the FogFlow edge worker
    var myport = process.env.myport;

    // set up the NGSI agent to listen on 
    NGSIAgent.setNotifyHandler(handleNotify);
    NGSIAgent.setAdminHandler(handleAdmin);
    NGSIAgent.start(myport, startApp);

    process.on('SIGINT', function() {
        NGSIAgent.stop();
        stopApp();

        process.exit(0);
    });
}

// launched by FogFlow in the operation phase
function runInOperationMode() {
    console.log("======== OPERATION MODE===========");

    // apply the configuration
    var adminCfg = process.env.adminCfg;
    console.log("handle the initial admin configuration", adminCfg)
    try {
        const commands = JSON.parse(adminCfg)
        handleCmds(commands);
    } catch (err) {
        console.error(err)
    }

    var syncMode = process.env.sync;
    if (syncMode == 'yes') {
        query2execution()
    } else {
        notify2execution()
    }
}

// for the test during the development phase
function runInTestMode() {
    console.log("======== TEST MODE===========");

    // load the configuration
    try {
        const commands = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        handleCmds(commands);
    } catch (err) {
        console.error(err)
    }

    // trigger the test of data processing function
    query2execution();
}

// main
var myArgs = process.argv.slice(2);
console.log('myArgs: ', myArgs);

if (myArgs.length == 1 && myArgs[0] == '-o') {
    runInOperationMode();
} else {
    runInTestMode();
}