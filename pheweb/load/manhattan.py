
'''
This script creates json files which can be used to render Manhattan plots.
'''

# TODO: combine with QQ.

from .. import utils
conf = utils.conf

from ..file_utils import VariantFileReader, write_json

import os
import math
import datetime
import multiprocessing
from boltons.fileutils import mkdir_p


def rounded_neglog10(pval, neglog10_pval_bin_size, neglog10_pval_bin_digits):
    return round(-math.log10(pval) // neglog10_pval_bin_size * neglog10_pval_bin_size, neglog10_pval_bin_digits)


def get_pvals_and_pval_extents(pvals, neglog10_pval_bin_size):
    # expects that NEGLOG10_PVAL_BIN_SIZE is the distance between adjacent bins.
    pvals = sorted(pvals)
    extents = [[pvals[0], pvals[0]]]
    for p in pvals:
        if extents[-1][1] + neglog10_pval_bin_size * 1.1 > p:
            extents[-1][1] = p
        else:
            extents.append([p,p])
    rv_pvals, rv_pval_extents = [], []
    for (start, end) in extents:
        if start == end:
            rv_pvals.append(start)
        else:
            rv_pval_extents.append([start,end])
    return (rv_pvals, rv_pval_extents)


# TODO: convert bins from {(chrom, pos): []} to {chrom:{pos:[]}}?
def bin_variants(variant_iterator, bin_length, n_unbinned, neglog10_pval_bin_size, neglog10_pval_bin_digits):
    bins = {}
    unbinned_variant_heap = utils.Heap()
    chrom_n_bins = {}

    def bin_variant(variant):
        chrom_key = utils.chrom_order[variant['chrom']]
        pos_bin = variant['pos'] // bin_length
        chrom_n_bins[chrom_key] = max(chrom_n_bins.get(chrom_key,0), pos_bin)
        if (chrom_key, pos_bin) in bins:
            bin = bins[(chrom_key, pos_bin)]

        else:
            bin = {"chrom": variant['chrom'],
                   "startpos": pos_bin * bin_length,
                   "neglog10_pvals": set()}
            bins[(chrom_key, pos_bin)] = bin
        bin["neglog10_pvals"].add(rounded_neglog10(variant['pval'], neglog10_pval_bin_size, neglog10_pval_bin_digits))

    # put most-significant variants into the heap and bin the rest
    for variant in variant_iterator:
        unbinned_variant_heap.add(variant, variant['pval'])
        if len(unbinned_variant_heap) > n_unbinned:
            old = unbinned_variant_heap.pop()
            bin_variant(old)

    unbinned_variants = list(iter(unbinned_variant_heap))

    # unroll bins into simple array (preserving chromosomal order)
    binned_variants = []
    for chrom_key in sorted(chrom_n_bins.keys()):
        for pos_key in range(int(1+chrom_n_bins[chrom_key])):
            b = bins.get((chrom_key, pos_key), None)
            if b and len(b['neglog10_pvals']) != 0:
                b['neglog10_pvals'], b['neglog10_pval_extents'] = get_pvals_and_pval_extents(b['neglog10_pvals'], neglog10_pval_bin_size)
                b['pos'] = int(b['startpos'] + bin_length/2)
                del b['startpos']
                binned_variants.append(b)

    return binned_variants, unbinned_variants



@utils.star_kwargs
def make_json_file(src_filename, dest_filename):

    BIN_LENGTH = int(3e6)
    NEGLOG10_PVAL_BIN_SIZE = 0.05 # Use 0.05, 0.1, 0.15, etc
    NEGLOG10_PVAL_BIN_DIGITS = 2 # Then round to this many digits
    N_UNBINNED = 2000

    if conf.debug: print('{}\t{} -> {} (START)'.format(datetime.datetime.now(), src_filename, dest_filename))
    with VariantFileReader(src_filename) as variants:
        if conf.debug: print('{}\tOPENED {}'.format(datetime.datetime.now(), src_filename))
        variant_bins, unbinned_variants = bin_variants(
            variants, BIN_LENGTH, N_UNBINNED, NEGLOG10_PVAL_BIN_SIZE, NEGLOG10_PVAL_BIN_DIGITS)
        if conf.debug: print('{}\tBINNED VARIANTS'.format(datetime.datetime.now()))
    if conf.debug: print('{}\tCLOSED FILE'.format(datetime.datetime.now()))
    rv = {
        'variant_bins': variant_bins,
        'unbinned_variants': unbinned_variants,
    }

    write_json(filename=dest_filename, data=rv)
    print('{}\t{} -> {}'.format(datetime.datetime.now(), src_filename, dest_filename))


def get_conversions_to_do():
    phenocodes = [pheno['phenocode'] for pheno in utils.get_phenolist()]
    for phenocode in phenocodes:
        src_filename = os.path.join(conf.data_dir, 'augmented_pheno', phenocode)
        dest_filename = os.path.join(conf.data_dir, 'manhattan', '{}.json'.format(phenocode))
        if not os.path.exists(dest_filename) or os.stat(dest_filename).st_mtime < os.stat(src_filename).st_mtime:
            yield {
                'src_filename': src_filename,
                'dest_filename': dest_filename,
            }


def run(argv):

    mkdir_p(conf.data_dir + '/manhattan')
    mkdir_p(conf.data_dir + '/tmp')

    conversions_to_do = list(get_conversions_to_do())
    print('number of phenos to process:', len(conversions_to_do))
    if conf.debug:
        for c in conversions_to_do:
            make_json_file(c)
    else:
        with multiprocessing.Pool(utils.get_num_procs()) as p:
            p.map(make_json_file, conversions_to_do)