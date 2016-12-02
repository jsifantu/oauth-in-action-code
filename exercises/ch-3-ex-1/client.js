var express = require("express");
var request = require("sync-request");
var url = require("url");
var qs = require("qs");
var querystring = require('querystring');
var cons = require('consolidate');
var nosql = require('nosql').load('testdatabase.nosql');
var randomstring = require("randomstring");
var __ = require('underscore');
__.string = require('underscore.string');

var app = express();

app.engine('html', cons.underscore);
app.set('view engine', 'html');
app.set('views', 'files/client');

/**  authorization server information
var authServer = {
	authorizationEndpoint: 'http://localhost:9001/authorize',
	tokenEndpoint: 'http://localhost:9001/token'
};
**/
var authServer = {
	authorizationEndpoint: 'https://login.microsoftonline.com/48e4ca38-5e0d-44ed-be1d-62c039c65e9e/oauth2/authorize',
	tokenEndpoint: 'https://login.microsoftonline.com/48e4ca38-5e0d-44ed-be1d-62c039c65e9e/oauth2/token'
};

// client information
/*
 * Add the client information in here
 
var client = {
	"client_id": "oauth-client-1",
	"client_secret": "oauth-client-secret-1",
	"redirect_uris": ["http://localhost:9000/callback"]
};
*/
var client = {
	"client_id": "84dab70f-99bc-453b-b42d-a6b12ebfebfe",
	"client_secret": "KCsYwnYJTNxQDT/bEtkQGQVvOcXJpigA9QCL+vdZWas=",
	"redirect_uris": ["http://10.20.13.175:9000/callback"],
	"resource": "https://management.azure.com/",
	"billing_uri": "https://management.azure.com/subscriptions/e606dead-0eec-4715-b6c2-61d4cdfd07bd/providers/Microsoft.Commerce/UsageAggregates",
	"subscription_id": "e606dead-0eec-4715-b6c2-61d4cdfd07bd"
};

var protectedResource = 'http://localhost:9002/resource';
var state = null;
var access_token = null;
var scope = null;
var refresh_token = null; 

app.get('/', function (req, res) {
	res.render('index', {access_token: access_token, scope: scope});
});

app.get('/authorize', function(req, res){

	/*
	 * Send the user to the authorization server
	 */
	access_token = null;
	state = randomstring.generate();
	var authorizeUrl = buildUrl(authServer.authorizationEndpoint, {
		response_type: 'code',
		response_mode: 'query',
		client_id: client.client_id,
		redirect_uri: client.redirect_uris[0],
		resource: client.resource,
		state: state,
		prompt: 'login',
		login_hint: 'jean_sifantus@bmc.com'
	});
	console.log("redirect", authorizeUrl);
	res.redirect(authorizeUrl);	
});

app.get('/callback', function(req, res){
	if (req.query.error) {
		console.log("Error from request: %s", req.query.error);
		res.render('error', {error: req.query.error});
		return;
	}
    if (req.query.state != state) {
		console.log("State DOES NOT MATCH: expected %s got %s.", state, req.query.state);
		res.render('error', {error: 'State value did not match.'});
		return;
	}
	/*
	 * Parse the response from the authorization server and get a token
	 */
	var code = req.query.code;
	var form_data = qs.stringify({
		client_id: client.client_id,
		grant_type: 'authorization_code',
		code: code,
		redirect_uri: client.redirect_uris[0],
		client_secret: client.client_secret,
		resource: client.resource
	});
	var headers = {
		'Content-Type': 'application/x-www-form-urlencoded',
		'Authorization': 'Basic ' + encodeClientCredentials(client.client_id,
       		client.client_secret)
	};
	var tokRes = request('POST', authServer.tokenEndpoint, {
		body: form_data,
		headers: headers
	});
	console.log('Requesting access token for code %s.', code);
	if (tokRes.statusCode >= 200 && tokRes.statusCode < 300) {
		var body = JSON.parse(tokRes.getBody());
		access_token = body.access_token;
		console.log('Got access token: %s', access_token);
		console.log('Access Token Expires in %s seconds on %s', body.expires_in, body.expires_on);
		if (body.refresh_token) {
			refresh_token = body.refresh_token;
			console.log('Got refresh_token: %s', refresh_token);
		}
		scope = body.scope;
		console.log('Got scope: %s', scope);
		nosql.insert({
			access_token: access_token,
			client_id: client.client_id,
			refresh_token: refresh_token,
			scope: scope
		});
		res.render('index', {access_token: access_token, scope: scope});
	} else {
		res.render('error', {error: 'Unable to fetch access token. HTTP Status Code: '
			+ tokRes.statusCode});
	}	
});

app.get('/fetch_resource', function(req, res) {

	/*
	 * Use the access token to call the resource server
	 */
	if (!access_token) {
		res.render('error', {error: 'Missing Access Token'}); 
		return;
	}
	console.log('Making request with access token %s', access_token);
	var headers = {
		'Content-Type': 'application/json',
		'Authorization': 'Bearer ' + access_token
	};
	var resourceUrl = buildUrl(client.billing_uri, {
		'api-version': "2015-06-01-preview",
		reportedStartTime: "2016-11-01T00:00:00Z",
		reportedEndTime: "2016-11-30T00:00:00Z"
		// aggregationGranularity: "Daily",
		// showDetails: "true"
	});
	console.log('REST API Request: %s', resourceUrl);
	var resource = request('GET', resourceUrl, {
		headers: headers
	});
	if (resource.statusCode >= 200 && resource.statusCode < 300) { 
		var body = JSON.parse(resource.getBody()); 
		res.render('data', {resource: body});
	} else {
		access_token = null;
		if (refresh_token) {
			refreshAccessToken(req, res);
		} else {
			console.log('Resource Access Error: %s', resource.body);
			res.render('error', {error: "Status Code: " + resource.statusCode});
		} 
	}	
});

// Utility functions ==================================

var buildUrl = function(base, options, hash) {
	var newUrl = url.parse(base, true);
	delete newUrl.search;
	if (!newUrl.query) {
		newUrl.query = {};
	}
	__.each(options, function(value, key, list) {
		newUrl.query[key] = value;
	});
	if (hash) {
		newUrl.hash = hash;
	}
	
	return url.format(newUrl);
};

var encodeClientCredentials = function(clientId, clientSecret) {
	return new Buffer(querystring.escape(clientId) + ':' + querystring.escape(clientSecret)).toString('base64');
};

var refreshAccessToken = function(req, res) {
	var form_data = qs.stringify({
		grant_type: 'refresh_token',
		refresh_token: refresh_token
	});
	var headers = {
		'Content-Type': 'application/x-www-form-urlencoded',
		'Authorization': 'Basic ' + encodeClientCredentials(client.client_id, client.client_secret)
	};
	console.log('Refreshing token %s', refresh_token);
	var tokRes = request('POST', authServer.tokenEndpoint, {	
			body: form_data,
			headers: headers
	});
	if (tokRes.statusCode >= 200 && tokRes.statusCode < 300) {
		var body = JSON.parse(tokRes.getBody());

		access_token = body.access_token;
		console.log('Got access token: %s', access_token);
		if (body.refresh_token) {
			refresh_token = body.refresh_token;
			console.log('Got refresh token: %s', refresh_token);
		}
		scope = body.scope;
		console.log('Got scope: %s', scope);
		nosql.insert({
			access_token: access_token,
			client_id: client.client_id,
			refresh_token: refresh_token,
			scope: scope
		});
		// try again
		res.redirect('/fetch_resource');
		return;
	} else {
		console.log('No refresh token, asking the user to get a new access token');
		// tell the user to get a new access token
		refresh_token = null;
		res.render('error', {error: 'Unable to refresh token.'});
		return;
	}
};

// =====================================================

app.use('/', express.static('files/client'));
nosql.clear();

var server = app.listen(9000, '10.20.13.175', function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log('OAuth Client is listening at http://%s:%s', host, port);
});
 
