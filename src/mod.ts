import * as fs from "node:fs";
import * as path from "node:path";

import { DependencyContainer } from "tsyringe";

import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { IDatabaseTables } from "@spt-aki/models/spt/server/IDatabaseTables";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { IPreAkiLoadMod } from "@spt-aki/models/external/IPreAkiLoadMod";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";
import { ILocation } from "@spt-aki/models/eft/common/ILocation";
import { Spawnpoint } from "@spt-aki/models/eft/common/ILooseLoot";
import { IStaticAmmoDetails } from "@spt-aki/models/eft/common/tables/ILootBase";
import { IContainerItem, LocationGenerator } from "@spt-aki/generators/LocationGenerator";
import { Item } from "@spt-aki/models/eft/common/tables/IItem";
import { ConfigServer } from "@spt-aki/servers/ConfigServer";
import { ItemHelper } from "@spt-aki/helpers/ItemHelper";
import { RandomUtil } from "@spt-aki/utils/RandomUtil";
import { ObjectId } from "@spt-aki/utils/ObjectId";
import { ILocationConfig } from "@spt-aki/models/spt/config/ILocationConfig";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { ConfigTypes } from "@spt-aki/models/enums/ConfigTypes";
import { BaseClasses } from "@spt-aki/models/enums/BaseClasses";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";

class Mod implements IPreAkiLoadMod, IPostDBLoadMod {
    private static container: DependencyContainer;
    reparentItemAndChildren: (itemWithChildren: Item[], newId?: string) => void;
    private objectId: ObjectId;
    private database: IDatabaseTables;
    private jsonUtil: JsonUtil;
    private logger: ILogger;

    public preAkiLoad(container: DependencyContainer): void {
        Mod.container = container;

        container.afterResolution("LocationGenerator", (_t, result: LocationGenerator) => {
            this.reparentItemAndChildren = result.reparentItemAndChildren;
            result.createDynamicLootItem = (chosenComposedKey: string, spawnPoint: Spawnpoint, staticAmmoDist: Record<string, IStaticAmmoDetails[]>) => {
                return this.replacementFunction(chosenComposedKey, spawnPoint, staticAmmoDist);
            }
        }, {frequency: "Always"});
    }
	
    public postDBLoad(container: DependencyContainer): void {
        Mod.container = container;
        
        this.database = Mod.container.resolve<DatabaseServer>("DatabaseServer").getTables();
        this.jsonUtil = Mod.container.resolve<JsonUtil>("JsonUtil");
        this.logger = Mod.container.resolve<ILogger>("WinstonLogger");

        this.backportLootChanges();
        this.logger.log("Loot Updated. Have a nice day.", LogTextColor.MAGENTA);
    }

    public replacementFunction(chosenComposedKey: string, spawnPoint: Spawnpoint, staticAmmoDist: Record<string, IStaticAmmoDetails[]>): IContainerItem {
        const configServer = Mod.container.resolve<ConfigServer>("ConfigServer");
        const itemHelper = Mod.container.resolve<ItemHelper>("ItemHelper");
        const randomUtil = Mod.container.resolve<RandomUtil>("RandomUtil");
        const objectId = Mod.container.resolve<ObjectId>("ObjectId");
        this.objectId = objectId;
        const locationConfig: ILocationConfig = configServer.getConfig(ConfigTypes.LOCATION);
        

        const chosenItem = spawnPoint.template.Items.find((item) => item._id === chosenComposedKey);
        const chosenTpl = chosenItem?._tpl;
        if (!chosenTpl) {
            throw new Error(`Item for tpl ${chosenComposedKey} was not found in the spawn point`);
        }
        const itemTemplate = itemHelper.getItem(chosenTpl)[1];

        // Item array to return
        const itemWithMods: Item[] = [];

        // Money/Ammo - don't rely on items in spawnPoint.template.Items so we can randomise it ourselves
        if (itemHelper.isOfBaseclasses(chosenTpl, [BaseClasses.MONEY, BaseClasses.AMMO])) {
            const stackCount
                = itemTemplate._props.StackMaxSize === 1
                    ? 1
                    : randomUtil.getInt(itemTemplate._props.StackMinRandom!, itemTemplate._props.StackMaxRandom!);

            itemWithMods.push({
                _id: objectId.generate(),
                _tpl: chosenTpl,
                upd: { StackObjectsCount: stackCount }
            });
        }
        else if (itemHelper.isOfBaseclass(chosenTpl, BaseClasses.AMMO_BOX)) {
            // Fill with cartridges
            const ammoBoxItem: Item[] = [{ _id: objectId.generate(), _tpl: chosenTpl }];
            itemHelper.addCartridgesToAmmoBox(ammoBoxItem, itemTemplate);
            itemWithMods.push(...ammoBoxItem);
        }
        else if (itemHelper.isOfBaseclass(chosenTpl, BaseClasses.MAGAZINE)) {
            // Create array with just magazine
            const magazineItem: Item[] = [{ _id: objectId.generate(), _tpl: chosenTpl }];

            if (randomUtil.getChance100(locationConfig.staticMagazineLootHasAmmoChancePercent)) {
                // Add randomised amount of cartridges
                itemHelper.fillMagazineWithRandomCartridge(
                    magazineItem,
                    itemTemplate, // Magazine template
                    staticAmmoDist,
                    undefined,
                    locationConfig.minFillLooseMagazinePercent / 100
                );
            }

            itemWithMods.push(...magazineItem);
        }
        else {
            // Also used by armors to get child mods
            // Get item + children and add into array we return
            const itemWithChildren = itemHelper.findAndReturnChildrenAsItems(
                spawnPoint.template.Items,
                chosenItem._id
            );

            // We need to reparent to ensure ids are unique
            this.reparentItemAndChildren(itemWithChildren);

            itemWithMods.push(...itemWithChildren);
        }

        // Get inventory size of item
        const size = itemHelper.getItemSize(itemWithMods, itemWithMods[0]._id);
        //this.logger.log("You're cute <3", LogTextColor.MAGENTA);

        return { items: itemWithMods, width: size.width, height: size.height };
    }

    public backportLootChanges(): void {
        const locations = new Map<string, string>();
        locations.set("Factory", "factory4_day");
        locations.set("Customs", "bigmap");
        locations.set("Woods", "woods");
        locations.set("Shoreline", "shoreline");
        locations.set("Interchange", "interchange");
        locations.set("Laboratory", "laboratory");
        locations.set("ReserveBase", "rezervbase");
        locations.set("Lighthouse", "lighthouse");
        locations.set("Streets of Tarkov", "tarkovstreets");
        locations.set("Sandbox", "sandbox");
        const dbPath = path.resolve(__dirname, "../db");

        for (const arr of locations) {
            const location: ILocation = this.database.locations[arr[1]];
            location.looseLoot = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/${arr[1]}/looseLoot.json`, "utf-8"));
            this.database.loot.staticContainers[arr[0]] = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/${arr[1]}/staticContainers.json`, "utf-8"));
        }
        // Factory day/night share static containers, but not loose loot.
        this.database.locations.factory4_night.looseLoot = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/factory4_night/looseLoot.json`, "utf-8"));
    }
}


module.exports = { mod: new Mod() }
