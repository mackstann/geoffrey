var gea = require("./lib/gea2.js");

const gea_address = 0x83;
const app_version = [0, 0, 0, 0];

gea.bind(gea_address, app_version, function(bus) {
    bus.once("geospring", function(hwh) {
        setInterval(function(){
            hwh.readKwhData(function(err, data){
                if(err)
                {
                    //console.error("error reading kwh data:", err);
                    return;
                }
                console.log(data.energy_Ws / 3600.0);
            });
        }, 3000);
    }); 
});
