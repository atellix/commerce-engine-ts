import { v4 as uuidv4 } from 'uuid'
import N3 from 'n3'

import { AbstractProperty, AbstractDefinition, AbstractDefinitionMap } from './schema.js'

const { namedNode, literal, quad } = N3.DataFactory

type AbstractPropertyMap = { [key: string]: AbstractProperty }
type AbstractTypeUriMap = { [key: string]: string }
type PropertyCache = { [key: string]: {
    uris: { [key: string]: string },
    properties: { [key: string]: AbstractProperty },
} }

export function getBeginningOfDay (date: Date): Date {
    const dt = new Date(date)
    dt.setHours(0, 0, 0, 0)
    return dt
}

export function isBeginningOfDay (date: Date): boolean {
    const dt = new Date(date)
    dt.setHours(0, 0, 0, 0)
    return dt.getTime() === date.getTime()
}

export class ObjectBuilder {
    private defs: AbstractDefinitionMap
    private typeDefs: AbstractTypeUriMap

    constructor(defs: AbstractDefinitionMap) {
        this.defs = defs
        this.typeDefs = {}
        Object.entries(defs).forEach(([key, value]) => {
            this.typeDefs[value.uri] = key
        })
    }

    getAllProperties (type: string, cache: PropertyCache): AbstractPropertyMap {
        if (type in cache) {
            return cache[type].properties
        }
        const def = this.defs[type]
        var allProps: AbstractPropertyMap
        if (def.extends && def.extends !== 'IObject') {
            allProps = this.getAllProperties(def.extends, cache)
        } else {
            allProps = {}
        }
        Object.entries(def.properties).forEach(([key, value]) => {
            allProps[key] = value
        })
        return allProps
    }

    getAllPropertyUris (type: string, cache: PropertyCache): { [key: string]: string } {
        if (type in cache) {
            return cache[type].uris
        }
        const def = this.defs[type]
        var allProps: { [key: string]: string }
        if (def.extends && def.extends !== 'IObject') {
            allProps = this.getAllPropertyUris(def.extends, cache)
        } else {
            allProps = {}
        }
        Object.entries(def.propertyUris).forEach(([key, value]) => {
            allProps[key] = value
        })
        return allProps
    }

    isLiteral (type: string): boolean {
        return type === 'string' || type === 'number' || type === 'boolean' || type === 'Date'
    }

    buildLiteral (store: any, node: string, property: string, type: string, dkey: string, dval: any) {
        if (type === 'string' || type === 'number' || type === 'boolean') {
            if (dkey === 'uuid') {
                store.addQuad(quad(namedNode(node), namedNode(property), namedNode('urn:uuid:' + dval.toLowerCase())))
            } else {
                store.addQuad(quad(namedNode(node), namedNode(property), literal(dval)))
            }
        } else if (type === 'Date') {
            if (isBeginningOfDay(dval)) {
                store.addQuad(quad(namedNode(node), namedNode(property), literal(dval.toLocaleDateString())))
            } else {
                store.addQuad(quad(namedNode(node), namedNode(property), literal(dval)))
            }
        }
    }

    buildObject (store: any, propertyDef: AbstractProperty, dval: any, cache: PropertyCache, baseUri: string): string {
        var subItemUri: string
        if ('id' in dval) {
            subItemUri = dval['id']
        } else {
            subItemUri = baseUri + '#' + uuidv4()
        }
        var subType = propertyDef.type
        if (propertyDef.isMultiType) {
            if ('type' in dval) {
                subType = dval.type
            } else {
                console.error(`Unable to determine object type from ${subType} without 'type'`)
            }
        }
        this.buildResource(store, subType, subItemUri, dval, cache, baseUri)
        return subItemUri
    }

    buildResource (store: any, type: string, node: string, obj: any, cache: PropertyCache, baseUri: string = '') {
        const def = this.defs[type]
        store.addQuad(quad(namedNode(node), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode(def.uri)))
        var allProps: AbstractPropertyMap;
        if (type in cache) {
            allProps = cache[type].properties
        } else {
            allProps = this.getAllProperties(type, cache)
            cache[type] = { properties: allProps, uris: {} }
        }
        if (!baseUri) {
            baseUri = node
        }
        Object.entries(allProps).forEach(([key, value]) => {
            let dkey = key as keyof typeof obj
            if (value.isOptional) {
                if (!(dkey in obj)) {
                    return
                }
            }
            let dval = obj[dkey]
            if (value.isArray && (dval as any[]).length > 1) {
                const itemList = namedNode(baseUri + '#' + uuidv4())
                store.addQuad(quad(itemList, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://schema.org/ItemList')))
                store.addQuad(quad(namedNode(node), namedNode(value.uri), itemList))
                for (var i = 0; i < (dval as any[]).length; i++) {
                    const itemUri = baseUri + '#' + uuidv4()
                    const item = namedNode(itemUri)
                    store.addQuad(quad(itemList, namedNode('http://schema.org/itemListElement'), item))
                    store.addQuad(quad(item, namedNode('http://schema.org/position'), literal(i)))
                    if (this.isLiteral(value.type)) {
                        this.buildLiteral(store, itemUri, 'http://schema.org/item', value.type, dkey as string, dval[i])
                    } else {
                        var subItemUri = this.buildObject(store, value, dval[i], cache, baseUri)
                        store.addQuad(quad(item, namedNode('http://schema.org/item'), namedNode(subItemUri)))
                    }
                }
            } else {
                let dval = obj[dkey]
                if (value.isArray) {
                    dval = dval[0]
                }
                if (this.isLiteral(value.type)) {
                    this.buildLiteral(store, node, value.uri, value.type, dkey as string, dval)
                } else {
                    const subItemUri = this.buildObject(store, value, dval, cache, baseUri)
                    store.addQuad(quad(namedNode(node), namedNode(value.uri), namedNode(subItemUri)))
                }
            }
        })
    }

    decodeArray (store: any, nodeUri: string, literalVal: boolean, type: string, propKey: string, cache: PropertyCache): any[] {
        const node = namedNode(nodeUri)
        const vals = store.getQuads(node, namedNode('http://schema.org/itemListElement'), null, null)
        var output: any[] = []
        vals.forEach((q) => {
            const listItem = q.object
            const pos = store.getQuads(listItem, namedNode('http://schema.org/position'), null, null)
            const item = store.getQuads(listItem, namedNode('http://schema.org/item'), null, null)
            if (pos.length === 1 && item.length === 1) {
                output.push([parseInt(pos[0].object.value), item[0].object])
            }
        })
        output.sort((a, b) => {
            if (a[0] < b[0]) { return -1 }
            if (a[0] > b[0]) { return 1 }
            return 0
        })
        if (literalVal) {
            output = output.map((r) => this.decodeLiteral(type, propKey, r[1].value))
        } else {
            output = output.map((r) => this.decodeResource(store, r[1], cache))
        }
        return output
    }

    isItemList (store: any, term: any): boolean {
        if (term.termType === 'NamedNode') {
            const li = store.getQuads(term, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://schema.org/ItemList'), null)
            if (li.length === 1) {
                return true
            }
        }
        return false
    }

    decodeLiteral (type: string, propKey: string, value: any): string | Date | number | boolean | undefined {
        if (type === 'string') {
            if (propKey === 'uuid') {
                return value.substring(9).toLowerCase()
            }
            return value
        } else if (type === 'Date') {
            return new Date(value)
        } else if (type === 'number') {
            return Number(value) as number
        } else if (type === 'boolean') {
            return (value.toLowerCase() === 'true') ? true : false
        }
    }

    decodeResource (store: any, nodeUri: any, cache: PropertyCache, specifyType: string = ''): { [key: string]: any } {
        const node = (typeof nodeUri === 'string') ? namedNode(nodeUri) : nodeUri
        const types = store.getQuads(node, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), null, null)
        const nodeId = (node.termType === 'BlankNode') ? '_:' + node.value : node.value
        var item: { [key: string]: any } = { id: nodeId, type: '' }
        for (var t = 0; t < types.length; t++) {
            if (types[t].object.value in this.typeDefs) {
                item.type = this.typeDefs[types[t].object.value]
                break
            }
        }
        var type: string = ''
        if (item.type === '') {
            if (specifyType) {
                type = item.type = specifyType
            } else {
                const typeList = types.map((t) => t.object.value).join(', ')
                console.log(`Type not found for URI: ${nodeUri.value} (types: ${typeList})`)
                return {}
            }
        } else {
            type = item.type
        }
        //console.log(`decodeResource URI: ${nodeUri} type: ${type}`)
        var allProps: AbstractPropertyMap;
        var allUris: { [key: string]: string };
        if (type in cache) {
            allProps = cache[type].properties
            allUris = cache[type].uris
        } else {
            allProps = this.getAllProperties(type, cache)
            allUris = this.getAllPropertyUris(type, cache)
            cache[type] = { properties: allProps, uris: allUris }
        }
        const vals = store.getQuads(node, null, null, null)
        for (var i = 0; i < vals.length; i++) {
            const propUri = vals[i].predicate.value
            //console.log(`decodeResource: ${nodeUri} property: ${propUri}`)
            if (propUri in allUris) {
                const propKey = allUris[propUri]
                const prop = allProps[propKey]
                const literalVal: boolean = this.isLiteral(prop.type)
                if (prop.isArray && this.isItemList(store, vals[i].object)) {
                    item[propKey] = this.decodeArray(store, vals[i].object.value, literalVal, prop.type, propKey, cache)
                } else {
                    var newval
                    if (literalVal) {
                        newval = this.decodeLiteral(prop.type, propKey, vals[i].object.value)
                    } else {
                        if (prop.isMultiType) {
                            newval = this.decodeResource(store, vals[i].object, cache)
                        } else {
                            newval = this.decodeResource(store, vals[i].object, cache, prop.type)
                        }
                    }
                    if (prop.isArray) {
                        if (propKey in item) {
                            item[propKey].push(newval)
                        } else {
                            item[propKey] = [newval]
                        }
                    } else {
                        item[propKey] = newval
                    }
                }
            }
        }
        return item
    }

    getUriForUUID (store: any, uuid: string): string | null {
        const vals = store.getQuads(null, namedNode('http://rdf.atellix.net/1.0/schema/catalog/Object.uuid'), namedNode('urn:uuid:' + uuid.toLowerCase()), null)
        if (vals.length === 1) {
            return vals[0].subject.value
        }
        return null
    }

    getType (store: any, nodeUri: string): string | null {
        const vals = store.getQuads(namedNode(nodeUri), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), null, null)
        for (var i = 0; i < vals.length; i++) {
            if (vals[i].object.value in this.typeDefs) {
                return this.typeDefs[vals[i].object.value]
            }
        }
        return null
    }
}

