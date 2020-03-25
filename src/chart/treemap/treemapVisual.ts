/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import VisualMapping, { VisualMappingOption } from '../../visual/VisualMapping';
import { map, each, extend, isArray } from 'zrender/src/core/util';
import TreemapSeriesModel, { TreemapSeriesNodeItemOption, TreemapSeriesOption } from './TreemapSeries';
import { TreemapLayoutNode, TreemapItemLayout } from './treemapLayout';
import Model from '../../model/Model';
import { ColorString, ZRColor } from '../../util/types';
import { modifyHSL, modifyAlpha } from 'zrender/src/tool/color';
import { makeInner } from '../../util/model';

type NodeModel = Model<TreemapSeriesNodeItemOption>;
type NodeItemStyleModel = Model<TreemapSeriesNodeItemOption['itemStyle']>;

const ITEM_STYLE_NORMAL = 'itemStyle';

const inner = makeInner<{
    drColorMappingBy: TreemapSeriesNodeItemOption['colorMappingBy']
}, VisualMapping>();

interface TreemapVisual {
    color?: ZRColor
    colorAlpha?: number
    colorSaturation?: number
}

type TreemapLevelItemStyleOption = TreemapSeriesOption['levels'][number]['itemStyle'];

export default {
    seriesType: 'treemap',
    reset(seriesModel: TreemapSeriesModel) {
        let tree = seriesModel.getData().tree;
        let root = tree.root;
        let seriesItemStyleModel = seriesModel.getModel(ITEM_STYLE_NORMAL);

        if (root.isRemoved()) {
            return;
        }

        let levelItemStyles = map(tree.levelModels, function (levelModel) {
            return levelModel ? levelModel.get(ITEM_STYLE_NORMAL) : null;
        });

        travelTree(
            root, // Visual should calculate from tree root but not view root.
            {},
            levelItemStyles,
            seriesItemStyleModel,
            seriesModel.getViewRoot().getAncestors(),
            seriesModel
        );
    }
};

function travelTree(
    node: TreemapLayoutNode,
    designatedVisual: TreemapVisual,
    levelItemStyles: TreemapLevelItemStyleOption[],
    seriesItemStyleModel: Model<TreemapSeriesOption['itemStyle']>,
    viewRootAncestors: TreemapLayoutNode[],
    seriesModel: TreemapSeriesModel
) {
    let nodeModel = node.getModel<TreemapSeriesNodeItemOption>();
    let nodeLayout = node.getLayout();

    // Optimize
    if (!nodeLayout || nodeLayout.invisible || !nodeLayout.isInView) {
        return;
    }

    let nodeItemStyleModel = nodeModel.getModel(ITEM_STYLE_NORMAL);
    let levelItemStyle = levelItemStyles[node.depth];
    let visuals = buildVisuals(
        nodeItemStyleModel, designatedVisual, levelItemStyle, seriesItemStyleModel
    );

    // calculate border color
    let borderColor = nodeItemStyleModel.get('borderColor');
    let borderColorSaturation = nodeItemStyleModel.get('borderColorSaturation');
    let thisNodeColor;
    if (borderColorSaturation != null) {
        // For performance, do not always execute 'calculateColor'.
        thisNodeColor = calculateColor(visuals);
        borderColor = calculateBorderColor(borderColorSaturation, thisNodeColor);
    }
    node.setVisual('borderColor', borderColor);

    let viewChildren = node.viewChildren;
    if (!viewChildren || !viewChildren.length) {
        thisNodeColor = calculateColor(visuals);
        // Apply visual to this node.
        node.setVisual('color', thisNodeColor);
    }
    else {
        let mapping = buildVisualMapping(
            node, nodeModel, nodeLayout, nodeItemStyleModel, visuals, viewChildren
        );

        // Designate visual to children.
        each(viewChildren, function (child, index) {
            // If higher than viewRoot, only ancestors of viewRoot is needed to visit.
            if (child.depth >= viewRootAncestors.length
                || child === viewRootAncestors[child.depth]
            ) {
                let childVisual = mapVisual(
                    nodeModel, visuals, child, index, mapping, seriesModel
                );
                travelTree(
                    child, childVisual, levelItemStyles, seriesItemStyleModel,
                    viewRootAncestors, seriesModel
                );
            }
        });
    }
}

function buildVisuals(
    nodeItemStyleModel: Model<TreemapSeriesNodeItemOption['itemStyle']>,
    designatedVisual: TreemapVisual,
    levelItemStyle: TreemapLevelItemStyleOption,
    seriesItemStyleModel: Model<TreemapSeriesOption['itemStyle']>
) {
    let visuals = extend({}, designatedVisual);

    each(['color', 'colorAlpha', 'colorSaturation'] as const, function (visualName) {
        // Priority: thisNode > thisLevel > parentNodeDesignated > seriesModel
        let val = nodeItemStyleModel.get(visualName, true); // Ignore parent
        val == null && levelItemStyle && (val = levelItemStyle[visualName]);
        val == null && (val = designatedVisual[visualName]);
        val == null && (val = seriesItemStyleModel.get(visualName));

        val != null && ((visuals as any)[visualName] = val);
    });

    return visuals;
}

function calculateColor(visuals: TreemapVisual) {
    let color = getValueVisualDefine(visuals, 'color') as ColorString;

    if (color) {
        let colorAlpha = getValueVisualDefine(visuals, 'colorAlpha') as number;
        let colorSaturation = getValueVisualDefine(visuals, 'colorSaturation') as number;
        if (colorSaturation) {
            color = modifyHSL(color, null, null, colorSaturation);
        }
        if (colorAlpha) {
            color = modifyAlpha(color, colorAlpha);
        }

        return color;
    }
}

function calculateBorderColor(
    borderColorSaturation: number,
    thisNodeColor: ColorString
) {
    return thisNodeColor != null
            // Can only be string
            ? modifyHSL(thisNodeColor, null, null, borderColorSaturation)
            : null;
}

function getValueVisualDefine(visuals: TreemapVisual, name: keyof TreemapVisual) {
    let value = visuals[name];
    if (value != null && value !== 'none') {
        return value;
    }
}

function buildVisualMapping(
    node: TreemapLayoutNode,
    nodeModel: NodeModel,
    nodeLayout: TreemapItemLayout,
    nodeItemStyleModel: NodeItemStyleModel,
    visuals: TreemapVisual,
    viewChildren: TreemapLayoutNode[]
) {
    if (!viewChildren || !viewChildren.length) {
        return;
    }

    let rangeVisual = getRangeVisual(nodeModel, 'color')
        || (
            visuals.color != null
            && visuals.color !== 'none'
            && (
                getRangeVisual(nodeModel, 'colorAlpha')
                || getRangeVisual(nodeModel, 'colorSaturation')
            )
        );

    if (!rangeVisual) {
        return;
    }

    let visualMin = nodeModel.get('visualMin');
    let visualMax = nodeModel.get('visualMax');
    let dataExtent = nodeLayout.dataExtent.slice() as [number, number];
    visualMin != null && visualMin < dataExtent[0] && (dataExtent[0] = visualMin);
    visualMax != null && visualMax > dataExtent[1] && (dataExtent[1] = visualMax);

    let colorMappingBy = nodeModel.get('colorMappingBy');
    let opt: VisualMappingOption = {
        type: rangeVisual.name,
        dataExtent: dataExtent,
        visual: rangeVisual.range
    };
    if (opt.type === 'color'
        && (colorMappingBy === 'index' || colorMappingBy === 'id')
    ) {
        opt.mappingMethod = 'category';
        opt.loop = true;
        // categories is ordinal, so do not set opt.categories.
    }
    else {
        opt.mappingMethod = 'linear';
    }

    let mapping = new VisualMapping(opt);
    inner(mapping).drColorMappingBy = colorMappingBy;

    return mapping;
}

// Notice: If we dont have the attribute 'colorRange', but only use
// attribute 'color' to represent both concepts of 'colorRange' and 'color',
// (It means 'colorRange' when 'color' is Array, means 'color' when not array),
// this problem will be encountered:
// If a level-1 node dont have children, and its siblings has children,
// and colorRange is set on level-1, then the node can not be colored.
// So we separate 'colorRange' and 'color' to different attributes.
function getRangeVisual(nodeModel: NodeModel, name: keyof TreemapVisual) {
    // 'colorRange', 'colorARange', 'colorSRange'.
    // If not exsits on this node, fetch from levels and series.
    let range = nodeModel.get(name);
    return (isArray(range) && range.length) ? {
        name: name,
        range: range
    } : null;
}

function mapVisual(
    nodeModel: NodeModel,
    visuals: TreemapVisual,
    child: TreemapLayoutNode,
    index: number,
    mapping: VisualMapping,
    seriesModel: TreemapSeriesModel
) {
    let childVisuals = extend({}, visuals);

    if (mapping) {
        // Only support color, colorAlpha, colorSaturation.
        let mappingType = mapping.type as keyof TreemapVisual;
        let colorMappingBy = mappingType === 'color' && inner(mapping).drColorMappingBy;
        let value = colorMappingBy === 'index'
            ? index
            : colorMappingBy === 'id'
            ? seriesModel.mapIdToIndex(child.getId())
            : child.getValue(nodeModel.get('visualDimension'));

        (childVisuals as any)[mappingType] = mapping.mapValueToVisual(value);
    }

    return childVisuals;
}