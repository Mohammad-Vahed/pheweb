'use strict';

// NOTE: `qval` means `-log10(pvalue)`.

function create_gwas_plot(variant_bins, unbinned_variants) {

    var get_chrom_offsets = _.memoize(function() {
        var chrom_padding = 2e7;
        var chrom_extents = {};

        var update_chrom_extents = function(variant) {
            if (!(variant.chrom in chrom_extents)) {
                chrom_extents[variant.chrom] = [variant.pos, variant.pos];
            } else if (variant.pos > chrom_extents[variant.chrom][1]) {
                chrom_extents[variant.chrom][1] = variant.pos;
            } else if (variant.pos < chrom_extents[variant.chrom][0]) {
                chrom_extents[variant.chrom][0] = variant.pos;
            }
        }
        variant_bins.forEach(update_chrom_extents);
        unbinned_variants.forEach(update_chrom_extents);

        var chroms = _.sortBy(Object.keys(chrom_extents), parseInt);

        var chrom_genomic_start_positions = {};
        chrom_genomic_start_positions[chroms[0]] = 0;
        for (var i=1; i<chroms.length; i++) {
            chrom_genomic_start_positions[chroms[i]] = chrom_genomic_start_positions[chroms[i-1]] + chrom_extents[chroms[i-1]][1] - chrom_extents[chroms[i-1]][0] + chrom_padding;
        }

        // chrom_offsets are defined to be the numbers that make `get_genomic_position()` work.
        // ie, they leave a gap of `chrom_padding` between the last variant on one chromosome and the first on the next.
        var chrom_offsets = {};
        Object.keys(chrom_genomic_start_positions).forEach(function(chrom) {
            chrom_offsets[chrom] = chrom_genomic_start_positions[chrom] - chrom_extents[chrom][0];
        });

        return {
            chrom_extents: chrom_extents,
            chroms: chroms,
            chrom_genomic_start_positions: chrom_genomic_start_positions,
            chrom_offsets: chrom_offsets,
        };
    });

    function get_genomic_position(variant) {
        var chrom_offsets = get_chrom_offsets().chrom_offsets;
        return chrom_offsets[variant.chrom] + variant.pos;
    }

    function get_y_axis_config(max_qval, plot_height) {

        var scale = d3.scale.linear().clamp(true);
        var draw_break_at_20;
        var possible_ticks = [];

        if (max_qval <= 40) {
            scale = scale
                .domain([max_qval, 0])
                .range([0, plot_height*0.97]);
            draw_break_at_20 = false;
            if (max_qval < 10) { possible_ticks = _.range(0, 10.1, 2); }
            else if (max_qval < 20) { possible_ticks = _.range(0, 20.1, 4); }
            else { possible_ticks = _.range(0, 40.1, 8); }

        } else {
            scale = scale
                .domain([max_qval, 20, 0])
                .range([0, plot_height*0.97/2, plot_height*0.97]);
            draw_break_at_20 = true;
            possible_ticks = _.range(0, 20.1, 4);
            if (max_qval <= 60) {
                possible_ticks = possible_ticks.concat([30,40,50,60]);
            } else if (max_qval <= 80) {
                possible_ticks = possible_ticks.concat([40,60,80,100]);
            } else if (max_qval <= 180) {
                possible_ticks = possible_ticks.concat([60,100,140,180]);
            } else {
                var power_of_ten = Math.pow(10, Math.floor(Math.log10(max_qval)));
                var first_digit = max_qval / power_of_ten;
                var multipliers;
                if (first_digit < 2) { multipliers = [0.5, 1, 1.5, 2]; }
                else if (first_digit < 4) { multipliers = [1, 2, 3, 4]; }
                else { multipliers = [2, 4, 6, 8, 10]; }
                possible_ticks = possible_ticks.concat(multipiers.map(function(m) { return m * power_of_ten; }));
            }
        }
        possible_ticks = possible_ticks.filter(function(qval) { return qval <= max_qval; });

        return {
            'scale': scale,
            'draw_break_at_20': draw_break_at_20,
            'ticks': possible_ticks,
        };
    }

    $(function() {
        var svg_width = $('#manhattan_plot_container').width();
        var svg_height = 550;
        var plot_margin = {
            'left': 70,
            'right': 30,
            'top': 10,
            'bottom': 50,
        };
        var plot_width = svg_width - plot_margin.left - plot_margin.right;
        var plot_height = svg_height - plot_margin.top - plot_margin.bottom;

        var gwas_svg = d3.select('#manhattan_plot_container').append("svg")
            .attr('id', 'gwas_svg')
            .attr("width", svg_width)
            .attr("height", svg_height)
            .style("display", "block")
            .style("margin", "auto");
        var gwas_plot = gwas_svg.append("g")
            .attr('id', 'gwas_plot')
            .attr("transform", fmt("translate({0},{1})", plot_margin.left, plot_margin.top));

        // Significance Threshold line
        var significance_threshold = 5e-8;
        var significance_threshold_tooltip = d3.tip()
            .attr('class', 'd3-tip')
            .html('Significance Threshold: 5E-8')
            .offset([-8,0]);
        gwas_svg.call(significance_threshold_tooltip);

        var genomic_position_extent = (function() {
            var extent1 = d3.extent(variant_bins, get_genomic_position);
            var extent2 = d3.extent(unbinned_variants, get_genomic_position);
            return d3.extent(extent1.concat(extent2));
        })();

        var x_scale = d3.scale.linear()
            .domain(genomic_position_extent)
            .range([0, plot_width]);

        // The top buffer `1.03` puts points clamped to the top (pval=0, qval=inf) slightly above other points.
        var highest_plot_qval = 1.03 * Math.max(
            -Math.log10(significance_threshold) + 1,
            (function() {
                var best_unbinned_qval = -Math.log10(d3.min(unbinned_variants, function(d) {
                    return (d.pval === 0) ? 1 : d.pval;
                }));
                if (best_unbinned_qval !== undefined) return best_unbinned_qval;
                return d3.max(variant_bins, function(bin) {
                    return d3.max(bin, _.property('qval'));
                });
            })());

        var y_axis_config = get_y_axis_config(highest_plot_qval, plot_height);
        var y_scale = y_axis_config.scale;
        if (unbinned_variants.filter(function(d) { return d.pval === 0; })) {
            // TODO: draw a small y-axis-break underneath "Infinity"
            y_axis_config.ticks.push(Infinity);
        }

        // TODO: draw a small y-axis-break at 20 if `y_axis_config.draw_break_at_20`
        var yAxis = d3.svg.axis()
            .scale(y_scale)
            .orient("left")
            .tickFormat(d3.format("d"))
            .tickValues(y_axis_config.ticks)
        gwas_plot.append("g")
            .attr("class", "y axis")
            .attr('transform', 'translate(-8,0)') // avoid letting points spill through the y axis.
            .call(yAxis);

        gwas_svg.append('text')
            .style('text-anchor', 'middle')
            .attr('transform', fmt('translate({0},{1})rotate(-90)',
                                   plot_margin.left*.4,
                                   plot_height/2 + plot_margin.top))
            .text('-log\u2081\u2080(p-value)'); // Unicode subscript "10"

        var chroms_and_midpoints = (function() {
            var v = get_chrom_offsets();
            return v.chroms.map(function(chrom) {
                return {
                    chrom: chrom,
                    midpoint: v.chrom_genomic_start_positions[chrom] + (v.chrom_extents[chrom][1] - v.chrom_extents[chrom][0]) / 2,
                };
            });
        })();

        var color_by_chrom = d3.scale.ordinal()
            .domain(get_chrom_offsets().chroms)
            .range(['rgb(120,120,186)', 'rgb(0,0,66)']);
        //colors to maybe sample from later:
        //.range(['rgb(120,120,186)', 'rgb(0,0,66)', 'rgb(44,150,220)', 'rgb(40,60,80)', 'rgb(33,127,188)', 'rgb(143,76,176)']);

        gwas_svg.selectAll('text.chrom_label')
            .data(chroms_and_midpoints)
            .enter()
            .append('text')
            .style('text-anchor', 'middle')
            .attr('transform', function(d) {
                return fmt('translate({0},{1})',
                           plot_margin.left + x_scale(d.midpoint),
                           plot_height + plot_margin.top + 20);
            })
            .text(function(d) {
                return d.chrom;
            })
            .style('fill', function(d) {
                return color_by_chrom(d.chrom);
            });

        gwas_plot.append('line')
            .attr('x1', 0)
            .attr('x2', plot_width)
            .attr('y1', y_scale(-Math.log10(significance_threshold)))
            .attr('y2', y_scale(-Math.log10(significance_threshold)))
            .attr('stroke-width', '5px')
            .attr('stroke', 'lightgray')
            .attr('stroke-dasharray', '10,10')
            .on('mouseover', significance_threshold_tooltip.show)
            .on('mouseout', significance_threshold_tooltip.hide);

        // Points & labels
        var tooltip_template = _.template(window.model.tooltip_underscoretemplate);
        var point_tooltip = d3.tip()
            .attr('class', 'd3-tip')
            .html(function(d) {
                return tooltip_template({d: d});
            })
            .offset([-6,0]);
        gwas_svg.call(point_tooltip);

        function get_link_to_LZ(variant) {
            return fmt('/region/{0}/{1}:{2}-{3}',
                       window.pheno,
                       variant.chrom,
                       Math.max(0, variant.pos - 200*1000),
                       variant.pos + 200*1000);
        }

        function pp1() {
        gwas_plot.append('g')
            .attr('class', 'variant_hover_rings')
            .selectAll('a.variant_hover_ring')
            .data(unbinned_variants)
            .enter()
            .append('a')
            .attr('class', 'variant_hover_ring')
            .attr('xlink:href', get_link_to_LZ)
            .append('circle')
            .attr('cx', function(d) {
                return x_scale(get_genomic_position(d));
            })
            .attr('cy', function(d) {
                return y_scale(-Math.log10(d.pval));
            })
            .attr('r', 7)
            .style('opacity', 0)
            .style('stroke-width', 1)
            .on('mouseover', function(d) {
                //Note: once a tooltip has been explicitly placed once, it must be explicitly placed forever after.
                var target_node = document.getElementById(fmt('variant-point-{0}-{1}-{2}-{3}', d.chrom, d.pos, d.ref, d.alt));
                point_tooltip.show(d, target_node);
            })
            .on('mouseout', point_tooltip.hide);
        }
        pp1();

        function pp2() {
        gwas_plot.append('g')
            .attr('class', 'variant_points')
            .selectAll('a.variant_point')
            .data(unbinned_variants)
            .enter()
            .append('a')
            .attr('class', 'variant_point')
            .attr('xlink:href', get_link_to_LZ)
            .append('circle')
            .attr('id', function(d) {
                return fmt('variant-point-{0}-{1}-{2}-{3}', d.chrom, d.pos, d.ref, d.alt);
            })
            .attr('cx', function(d) {
                return x_scale(get_genomic_position(d));
            })
            .attr('cy', function(d) {
                return y_scale(-Math.log10(d.pval));
            })
            .attr('r', 2.3)
            .style('fill', function(d) {
                return color_by_chrom(d.chrom);
            })
            .on('mouseover', function(d) {
                //Note: once a tooltip has been explicitly placed once, it must be explicitly placed forever after.
                point_tooltip.show(d, this);
            })
            .on('mouseout', point_tooltip.hide);
        }
        pp2();

        function pp3() { // drawing the ~60k binned variant circles takes ~500ms.  The (far fewer) unbinned variants take much less time.
        var bins = gwas_plot.append('g')
            .attr('class', 'bins')
            .selectAll('g.bin')
            .data(variant_bins)
            .enter()
            .append('g')
            .attr('class', 'bin')
            .each(function(d) { //todo: do this in a forEach
                d.x = x_scale(get_genomic_position(d));
                d.color = color_by_chrom(d.chrom);
            });
        bins.selectAll('circle.binned_variant_point')
            .data(_.property('qvals'))
            .enter()
            .append('circle')
            .attr('class', 'binned_variant_point')
            .attr('cx', function(d, i, parent_i) {
                return variant_bins[parent_i].x;
            })
            .attr('cy', function(qval) {
                return y_scale(qval);
            })
            .attr('r', 2.3)
            .style('fill', function(d, i, parent_i) {
                // return color_by_chrom(d3.select(this.parentNode).datum().chrom); //slow
                // return color_by_chrom(this.parentNode.__data__.chrom); //slow?
                // return this.parentNode.__data__.color;
                return variant_bins[parent_i].color;
            });
        bins.selectAll('circle.binned_variant_line')
            .data(_.property('qval_extents'))
            .enter()
            .append('line')
            .attr('class', 'binned_variant_line')
            .attr('x1', function(d, i, parent_i) { return variant_bins[parent_i].x; })
            .attr('x2', function(d, i, parent_i) { return variant_bins[parent_i].x; })
            .attr('y1', function(d) { return y_scale(d[0]); })
            .attr('y2', function(d) { return y_scale(d[1]); })
            .style('stroke', function(d, i, parent_i) { return variant_bins[parent_i].color; })
            .style('stroke-width', 4.6)
            .style('stroke-linecap', 'round');
        }
        pp3();

    });
}


function create_qq_plot(maf_ranges, qq_ci) {

    maf_ranges.forEach(function(maf_range, i) {
        maf_range.color = ['#e66101', '#fdb863', '#b2abd2', '#5e3c99'][i];
    })

    $(function() {

        if (typeof maf_ranges[0].qq.max_exp_qval === 'undefined') { // convert older datasets to work with this newer plotting code
            maf_ranges.forEach(function(maf_range) {
                maf_range.qq = {
                    bins: maf_range.qq,
                    max_exp_qval: -Math.log10(0.5/maf_range.count),
                };
            });
        }

        var exp_max = d3.max(maf_ranges, function(maf_range) {
            return maf_range.qq.max_exp_qval;
        });
        // Note: we already removed all observed -log10(pval)s > ceil(exp_max*2) in python, so we can just use the max observed here.
        var obs_max = d3.max(maf_ranges, function(maf_range) {
            return d3.max(maf_range.qq.bins, function(bin) {
                return bin[1];
            });
        });
        obs_max = Math.max(obs_max, exp_max);
        obs_max = Math.ceil(obs_max) + 0.01; // The 0.01 makes sure the integer tick will be shown.


        var svg_width = $('#qq_plot_container').width();
        var plot_margin = {
            'left': 70,
            'right': 30,
            'top': 10,
            'bottom': 120,
        };
        var plot_width = svg_width - plot_margin.left - plot_margin.right;
        // Size the plot to make things square.  This way, x_scale and y_scale should be exactly equivalent.
        var plot_height = plot_width / exp_max * obs_max;
        var svg_height = plot_height + plot_margin.top + plot_margin.bottom;

        // TODO: use a clip path to keep qq_ci below the upper edge
        var qq_svg = d3.select('#qq_plot_container').append("svg")
            .attr('id', 'qq_svg')
            .attr("width", svg_width)
            .attr("height", svg_height)
            .style("display", "block")
            .style("margin", "auto");
        var qq_plot = qq_svg.append("g")
            .attr('id', 'qq_plot')
            .attr("transform", fmt("translate({0},{1})", plot_margin.left, plot_margin.top));

        var x_scale = d3.scale.linear()
            .domain([0, exp_max])
            .range([0, plot_width]);
        var y_scale = d3.scale.linear()
            .domain([0, obs_max])
            .range([plot_height, 0]);

        // "trumpet" CI path
        qq_plot.append('path')
            .attr('class', 'trumpet_ci')
            .datum(qq_ci)
            .attr("d", d3.svg.area()
                  .x( function(d) {
                      return x_scale(d.x);
                  }).y0( function(d) {
                      return y_scale(d.y_max + .05)
                  }).y1( function(d) {
                      return y_scale(Math.max(0, d.y_min - .05));
                  }))
            .style("fill", "lightgray");

        // points
        qq_plot.append('g')
            .selectAll('g.qq_points')
            .data(maf_ranges)
            .enter()
            .append('g')
            .attr('class', 'qq_points')
            .selectAll('circle.qq_point')
            .data(function(maf_range) { return maf_range.qq.bins })
            .enter()
            .append('circle')
            .attr('cx', function(d) { return x_scale(d[0]); })
            .attr('cy', function(d) { return y_scale(d[1]); })
            .attr('r', 1.5)
            .attr('fill', function (d, i, parent_index) {
                return maf_ranges[parent_index].color;
            });

        var attempt_two_decimals = function(x) {
            if (x == 0) return '0';
            if (x >= 0.01) return x.toFixed(2);
            if (x >= 0.001) return x.toFixed(3);
            return x.toExponential(0);
        };

        // Legend
        qq_svg.append('g')
            .attr('transform', fmt('translate({0},{1})',
                                  plot_margin.left + plot_width,
                                  plot_margin.top + plot_height + 70))
            .selectAll('text.legend-items')
            .data(maf_ranges)
            .enter()
            .append('text')
            .attr('text-anchor', 'end')
            .attr('y', function(d,i) {
                return i + 'em';
            })
            .text(function(d) {
                return fmt('{0} ≤ MAF < {1} ({2})',
                           attempt_two_decimals(d.maf_range[0]),
                           attempt_two_decimals(d.maf_range[1]),
                           d.count);
            })
            .attr('fill', function(d) {
                return d.color;
            });

        // Axes
        var xAxis = d3.svg.axis()
            .scale(x_scale)
            .orient("bottom")
            .innerTickSize(-plot_height) // this approach to a grid is taken from <http://bl.ocks.org/hunzy/11110940>
            .outerTickSize(0)
            .tickPadding(7)
            .tickFormat(d3.format("d")) //integers
            .tickValues(_.range(exp_max)); //prevent unlabeled, non-integer ticks.
        qq_plot.append("g")
            .attr("class", "x axis")
            .attr("transform", fmt("translate(0,{0})", plot_height))
            .call(xAxis);

        var yAxis = d3.svg.axis()
            .scale(y_scale)
            .orient("left")
            .innerTickSize(-plot_width)
            .outerTickSize(0)
            .tickPadding(7)
            .tickFormat(d3.format("d")) //integers
            .tickValues(_.range(obs_max)); //prevent unlabeled, non-integer ticks.
        qq_plot.append("g")
            .attr("class", "y axis")
            .call(yAxis);

        qq_svg.append('text')
            .style('text-anchor', 'middle')
            .attr('transform', fmt('translate({0},{1})rotate(-90)',
                                   plot_margin.left*.4,
                                   plot_margin.top + plot_height/2))
            .text('observed -log\u2081\u2080(p)');

        qq_svg.append('text')
            .style('text-anchor', 'middle')
            .attr('transform', fmt('translate({0},{1})',
                                   plot_margin.left + plot_width/2,
                                   plot_margin.top + plot_height + 40))
            .text('expected -log\u2081\u2080(p)');
  });
}


function populate_streamtable(variants) {
    $(function() {
        // This is mostly copied from <https://michigangenomics.org/health_data.html>.
        var data = _.sortBy(_.where(variants, {peak: true}), _.property('pval'));
        var template = _.template($('#streamtable-template').html());
        var view = function(variant) {
            return template({v: variant});
        };
        var $found = $('#streamtable-found');
        $found.text(data.length + " total variants");

        var callbacks = {
            pagination: function(summary){
                if ($.trim($('#search').val()).length > 0){
                    $found.text(summary.total + " matching variants");
                } else {
                    $found.text(data.length + " total variants");
                }
            }
        }

        var options = {
            view: view,
            search_box: '#search',
            per_page: 20,
            callbacks: callbacks,
            pagination: {
                span: 5,
                next_text: 'Next <span class="glyphicon glyphicon-arrow-right" aria-hidden="true"></span>',
                prev_text: '<span class="glyphicon glyphicon-arrow-left" aria-hidden="true"></span> Previous',
                per_page_select: false,
                per_page: 10
            }
        }

        $('#stream_table').stream_table(options, data);

    });
}