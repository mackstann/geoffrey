// Copyright (c) 2014 Nick Welch <nick@incise.org>
//
// This file is part of geoffrey.
//
// geoffrey is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// geoffrey is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with geoffrey.  If not, see <http://www.gnu.org/licenses/>.

var fs = require("fs");
var http = require("http");
var url = require("url");

var connect = require("connect");
var express = require("express");
var gea = require("./lib/gea2.js");
var ini = require("ini");
var swig = require("swig");

var hwh_mode_ids = {
    "hybrid": 0,
    "electric": 1,
    "heat-pump": 2,
    "high-demand": 3,
    0: "hybrid",
    1: "electric",
    2: "heat-pump",
    3: "high-demand",
};

var hwh_mode_names = {
    "hybrid": "Hybrid",
    "electric": "Standard Electric",
    "heat-pump": "Heat Pump",
    "high-demand": "High Demand",
};

function off_by_one_workaround(mode_from_hwh) {
    // currently the mode returned by the water heater is one greater than
    // expected. work around it.
    return mode_from_hwh - 1;
}

var queue = [];

var gea_address = 0xbb;
var app_version = [0, 0, 0, 0];

console.log("init");
gea.bind(gea_address, app_version, function(bus) {
    console.log("bound");
    bus.once("geospring", function(hwh) {
        console.log("GeoSpring version:", hwh.version);

        var set_hwh_mode = function(hwh_mode_slug, description, success, error) {
            hwh.writeModeActual(hwh_mode_ids[hwh_mode_slug], function (err) {
                if(err)
                    error(description, err);
                else
                    success(description);
            });
        };

        var set_hwh_temp = function(temp, description, success, error) {
            if(temp < 100 || temp > 140)
            {
                error(description, "Only temperatures from 100-140 allowed.", true);
                return;
            }
            hwh.writeTankTempSetting(temp, function (err) {
                if(err)
                    error(description, err);
                else
                    success(description);
            });
        };

        var process_queue_timeout;
        var expire_mode_timeout;
        var modes;
        var active_mode_slug;
        var default_interval = 50;
        var interval = default_interval;

        var continue_queue = function () {
            if(queue.length)
            {
                if(!process_queue_timeout)
                    process_queue_timeout = setTimeout(process_queue_item, interval);
            }
            else
                console.log("sleeping...");
        };

        var queue_item_success = function (description) {
            console.log("[SUCCESS] " + description);
            queue.shift();
            interval = default_interval;
            continue_queue();
        };
        var queue_item_error = function (description, err, fatal) {
            console.log("[ERROR] '"+description+"': "+err);
            if(fatal)
                queue.shift();
            interval *= 2;
            continue_queue();
        };

        var process_queue_item = function () {
            process_queue_timeout = null;
            var item = queue[0];
            var description = item[0];
            var func = item[1];
            var s = queue_item_success;
            var e = queue_item_error;
            func(description, queue_item_success, queue_item_error);
        };

        var switch_to_mode = function (mode_slug) {
            var mode = modes[mode_slug];
            queue = [
                ["Set mode to " + mode.mode, function (d, s, e) { set_hwh_mode(mode.mode, d, s, e); }],
                ["Set temperature to " + mode.temp, function (d, s, e) { set_hwh_temp(parseInt(mode.temp), d, s, e); }],
                ["Record active mode: " + mode_slug, function (d, s, e) { active_mode_slug = mode_slug; s(d); }],
            ];
            if(expire_mode_timeout)
                clearTimeout(expire_mode_timeout);
            continue_queue();
        }

        var switch_to_normal = function () {
            switch_to_mode('normal');
        };

        // startup

        console.log('checking initial mode...');
        hwh.readModeSetting(function(err, data) {
            data = off_by_one_workaround(data);
            if(err)
            {
                console.error("error reading mode data:", err);
                // crash
            }
            var initial_hwh_mode = hwh_mode_ids[data];
            console.log('got initial mode: ' + initial_hwh_mode);

            console.log('checking initial temp...');
            hwh.readTempSetting(function(err, data) {
                if(err)
                {
                    console.error("error reading temp data:", err);
                    // crash
                }
                var initial_hwh_temp = data;
                console.log('got initial temp: ' + initial_hwh_temp);

                modes = ini.parse(fs.readFileSync('modes.ini', 'utf-8'))
                if(!('normal' in modes))
                {
                    // if config file has no normal mode, then take the current water
                    // heater settings and save them as the normal mode.
                    modes.normal.mode = initial_hwh_mode;
                    modes.normal.temp = initial_hwh_temp;
                    fs.writeFileSync('modes.ini', ini.stringify(modes));
                }
                else if(modes.normal.mode != initial_hwh_mode ||
                        modes.normal.temp != initial_hwh_temp)
                {
                    // if config file has a normal mode but the water heater is in
                    // some different mode at startup, switch to our normal mode.
                    switch_to_normal();
                }
                else
                    active_mode_slug = "normal";

                var app = express();
                app.use(function(req, res, next) {
                    var data = '';
                    req.setEncoding('utf8');
                    req.on('data', function(chunk) { 
                        data += chunk;
                    });

                    req.on('end', function() {
                        req.body = data;
                        next();
                    });
                });

                app.put('/mode', function (req, res) {
                    var mode_slug = req.body;
                    switch_to_mode(mode_slug);
                    expire_mode_timeout = setTimeout(switch_to_normal, parseInt(modes[mode_slug].duration_hours)*60*60*1000);
                    res.send("");
                });

                var template = swig.compileFile('index.html');
                app.get('/', function (req, res) {
                    hwh.readTempCurrent(function (err, data) {
                        var temp = err ? '?' : data;
                        res.send(template({
                            'modes': modes,
                            'active_mode_slug': active_mode_slug,
                            'temp': temp,
                        }));
                    });
                });

                var server = app.listen(8888, function() {
                    console.log('Listening on port %d', server.address().port);
                });

            });
        });

    }); 
});

