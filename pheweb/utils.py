
from __future__ import print_function, division, absolute_import

import re
import itertools
import functools
import traceback
import math
import json
import gzip
import os
import errno
import random
import sys
import subprocess
import time
import attrdict
import imp
import multiprocessing


conf = attrdict.AttrDict() # this gets populated by `ensure_conf_is_loaded()`, which is run-once and called at the bottom of this module.


def get_assoc_file_parser():
    from .load.input_file_parsers import epacts
    return epacts
    # TODO: how do I make this configurable?  I can't find the right syntax with imp.load_*.  Maybe in py3?
    #       if you use load_source, then it's not part of this package, so it can't do relative imports.
    # fname = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'load', 'input_file_parsers', conf['source_file_parser']+'.py')
    # return imp.load_source(conf['source_file_parser'], fname)


def parse_variant(query, default_chrom_pos = True):
    if isinstance(query, unicode):
        query = query.encode('utf-8')
    chrom_pattern = r'(?:[cC][hH][rR])?([0-9XYMT]+)'
    chrom_pos_pattern = chrom_pattern + r'[-_:/ ]([0-9]+)'
    chrom_pos_ref_alt_pattern = chrom_pos_pattern + r'[-_:/ ]([-AaTtCcGg\.]+)[-_:/ ]([-AaTtCcGg\.]+)'

    match = re.match(chrom_pos_ref_alt_pattern, query) or re.match(chrom_pos_pattern, query) or re.match(chrom_pattern, query)
    g = match.groups() if match else ()

    if default_chrom_pos:
        if len(g) == 0: g += ('1',)
        if len(g) == 1: g += (0,)
    if len(g) >= 2: g = (g[0], int(g[1])) + tuple([bases.upper() for bases in g[2:]])
    return g + tuple(itertools.repeat(None, 4-len(g)))


def parse_marker_id(marker_id):
    match = parse_marker_id.regex.match(marker_id)
    if match is None:
        raise Exception("ERROR: MARKER_ID didn't match our MARKER_ID pattern: {!r}".format(marker_id))
    chrom, pos, ref, alt = match.groups()
    return chrom, int(pos), ref, alt
parse_marker_id.regex = re.compile(r'([^:]+):([0-9]+)_([-ATCG\.]+)/([-ATCG\.]+)')


def round_sig(x, digits):
    return 0 if x==0 else round(x, digits-1-int(math.floor(math.log10(abs(x)))))
assert round_sig(0.00123, 2) == 0.0012
assert round_sig(1.59e-10, 2) == 1.6e-10


def get_phenolist():
    fname = os.path.join(conf['data_dir'], 'pheno-list.json')
    try:
        with open(os.path.join(fname)) as f:
            return json.load(f)
    except IOError: # TODO: these exceptions change in python3
        die("You need a file to define your phenotypes at '{fname}'.\n".format(fname=fname) +
            "For more information on how to make one, see <https://github.com/statgen/pheweb#3-make-a-list-of-your-phenotypes>")
    except ValueError:
        print("Your file at '{fname}' contains invalid json.\n".format(fname=fname) +
              "The error it produced was:")
        raise

def get_phenos_with_colnums(app_root_path):
    phenos_by_phenocode = {pheno['phenocode']: pheno for pheno in get_phenolist()}
    with gzip.open(conf['data_dir'] + '/matrix.tsv.gz') as f:
        header = f.readline().rstrip('\r\n').split('\t')
    assert header[:7] == '#chrom pos ref alt rsids nearest_genes maf'.split()
    for phenocode in phenos_by_phenocode:
        phenos_by_phenocode[phenocode]['colnum'] = {}
    for colnum, colname in enumerate(header[7:], start=7):
        label, phenocode = colname.split('@')
        phenos_by_phenocode[phenocode]['colnum'][label] = colnum
    for phenocode in phenos_by_phenocode:
        assert 'pval' in phenos_by_phenocode[phenocode]['colnum'], (phenocode, phenos_by_phenocode[phenocode])
    return phenos_by_phenocode


pheno_fields_to_include_with_variant = {
    'phenostring', 'category', 'num_cases', 'num_controls', 'num_samples',
}


def get_variant(query, phenos):
    import pysam
    # todo: differentiate between parse errors and variants-not-found
    chrom, pos, ref, alt = parse_variant(query)
    assert None not in [chrom, pos, ref, alt]

    tabix_file = pysam.TabixFile(conf['data_dir'] + '/matrix.tsv.gz')
    tabix_iter = tabix_file.fetch(chrom, pos-1, pos+1, parser = pysam.asTuple())
    for variant_row in tabix_iter:
        if int(variant_row[1]) == int(pos) and variant_row[3] == alt:
            matching_variant_row = tuple(variant_row)
            break
    else: # didn't break
        return None

    maf = round_sig(float(matching_variant_row[6]), 3)
    assert 0 < maf <= 0.5

    rv = {
        'variant_name': '{} : {:,} {}>{}'.format(chrom, pos, ref, alt),
        'chrom': chrom,
        'pos': pos,
        'ref': ref,
        'alt': alt,
        'maf': maf,
        'rsids': matching_variant_row[4],
        'nearest_genes': matching_variant_row[5],
        'phenos': [],
    }

    for phenocode, pheno in phenos.iteritems():
        try:
            pval = float(matching_variant_row[pheno['colnum']['pval']])
        except ValueError:
            pval = 1
        rv['phenos'].append({
            'phenocode': phenocode,
            'pval': pval,
        })
        for key in pheno:
            if key in pheno_fields_to_include_with_variant:
                rv['phenos'][-1][key] = pheno[key]
    return rv


def mkdir_p(path):
    # like `mkdir -p`
    try:
        os.makedirs(path)
    except OSError as exc:
        if exc.errno != errno.EEXIST or not os.path.isdir(path):
            raise

def get_random_page():
    with open(os.path.join(conf['data_dir'], 'top_hits.json')) as f:
        hits = json.load(f)
        hits_to_choose_from = [hit for hit in hits if hit['pval'] < 5e-8]
        if not hits_to_choose_from:
            hits_to_choose_from = hits
        if not hits:
            return None
    hit = random.choice(hits_to_choose_from)
    r = random.random()
    if r < 0.4:
        return '/pheno/{}'.format(hit['phenocode'])
    elif r < 0.8:
        return '/variant/{chrom}-{pos}-{ref}-{alt}'.format(**hit)
    else:
        offset = int(50e3)
        return '/region/{phenocode}/{chrom}:{pos1}-{pos2}'.format(pos1=hit['pos']-offset, pos2=hit['pos']+offset, **hit)


def die(message):
    print(message, file=sys.stderr)
    raise Exception()


def exception_printer(f):
    @functools.wraps(f)
    def f2(*args, **kwargs):
        try:
            rv = f(*args, **kwargs)
        except Exception as exc:
            time.sleep(2*random.random()) # hopefully avoid interleaved printing (when using multiprocessing)
            traceback.print_exc()
            strexc = str(exc) # parser errors can get very long
            if len(strexc) > 10000: strexc = strexc[1000:] + '\n\n...\n\n' + strexc[-1000:]
            print(strexc)
            if args: print('args were: {!r}'.format(args))
            if kwargs: print('kwargs were: {!r}'.format(args))
            raise
        return rv
    return f2

def exception_tester(f):
    @functools.wraps(f)
    def f2(*args, **kwargs):
        try:
            rv = f(*args, **kwargs)
        except Exception as exc:
            traceback.print_exc()
            strexc = str(exc) # parser errors can get very long
            if len(strexc) > 10000: strexc = strexc[1000:] + '\n\n...\n\n' + strexc[-1000:]
            print(strexc)
            if args: print('args were: {!r}'.format(args))
            if kwargs: print('kwargs were: {!r}'.format(args))
            return {'args': args, 'kwargs': kwargs, 'succeeded': False}
        return {'args': args, 'kwargs': kwargs, 'succeeded': True, 'rv': rv}
    return f2


def all_equal(iterator):
    try:
        first = next(iterator)
    except StopIteration:
        return True
    return all(it == first for it in iterator)


def sorted_groupby(iterator, key=None):
    if key is None: key = (lambda v:v)
    return [list(group) for _, group in itertools.groupby(sorted(iterator, key=key), key=key)]


class open_maybe_gzip(object):
    def __init__(self, fname, *args):
        self.fname = fname
        self.args = args
    def __enter__(self):
        is_gzip = False
        with open(self.fname, 'rb') as f:
            if f.read(3) == b'\x1f\x8b\x08':
                is_gzip = True
        if is_gzip:
            self.f = gzip.open(self.fname, *self.args)
        else:
            self.f = open(self.fname, *self.args)
        return self.f
    def __exit__(self, *exc):
        self.f.close()


def pairwise(iterable):
    "s -> (s0, s1), (s2, s3), (s4, s5), ..."
    it = iter(iterable)
    return itertools.izip(it, it)


# TODO: chrom_order_list[25-1] = 'M', chrom_order['M'] = 25-1, chrom_order['MT'] = 25-1 ?
#       and epacts.py should convert all chroms to chrom_idx?
chrom_order_list = [str(i) for i in range(1,22+1)] + ['X', 'Y', 'M', 'MT']
chrom_order = {chrom: index for index,chrom in enumerate(chrom_order_list)}


def get_path(cmd, attr=None):
    if attr is None: attr = '{}_path'.format(cmd)
    path = None
    if hasattr(conf, attr):
        path = getattr(conf, attr)
    else:
        try:
            path = subprocess.check_output(['which', cmd]).strip()
        except subprocess.CalledProcessError:
            pass
    if path is None:
        raise Exception("The command '{cmd}' was not found in $PATH and was not specified (as {attr}) in config.py.".format(cmd=cmd, attr=attr))
    return path


def run_script(script):
    script = 'set -euo pipefail\n' + script
    try:
        with open(os.devnull) as devnull:
            # is this the right way to block stdin?
            data = subprocess.check_output(['sh', '-c', script], stderr=subprocess.STDOUT, stdin=devnull)
        status = 0
    except subprocess.CalledProcessError as ex:
        data = ex.output
        status = ex.returncode
    data = data.decode('utf8')
    if status != 0:
        print('FAILED with status {}'.format(status))
        print('output was:')
        print(data)
        raise Exception()
    return data


def run_cmd(cmd):
    '''cmd must be a list of arguments'''
    try:
        with open(os.devnull) as devnull:
            # is this the right way to block stdin?
            data = subprocess.check_output(cmd, stderr=subprocess.STDOUT, stdin=devnull)
        status = 0
    except subprocess.CalledProcessError as ex:
        data = ex.output
        status = ex.returncode
    data = data.decode('utf8')
    if status != 0:
        print('FAILED with status {}'.format(status))
        print('output was:')
        print(data)
        raise Exception()
    return data


def get_num_procs():
    if hasattr(conf, 'num_proces'):
        return conf.num_procs
    n_cpus = multiprocessing.cpu_count()
    if n_cpus == 1: return 1
    if n_cpus < 4: return n_cpus - 1
    return n_cpus * 3//4


def dumb_cache(f):
    cache = {}
    @functools.wraps(f)
    def f2(*args, **kwargs):
        key = (tuple(args), tuple(kwargs.items()))
        if key not in cache:
            cache[key] = f(*args, **kwargs)
        return cache[key]
    return f2


@dumb_cache
def ensure_conf_is_loaded():

    conf.data_dir = os.environ.get('PHEWEB_DATADIR', False) or os.path.abspath(os.path.curdir)
    if not os.path.isdir(conf.data_dir):
        mkdir_p(conf.data_dir)
    if not os.access(conf.data_dir, os.R_OK):
        raise Exception("Your data directory, {!r}, is not readable.".format(conf.data_dir))

    config_file = os.path.join(conf.data_dir, 'config.py')
    if os.path.isfile(config_file):
        try:
            conf_module = imp.load_source('config', config_file)
        except:
            raise Exception("PheWeb tried to load your config.py at {!r} but it failed.".format(config_file))
        else:
            for key in dir(conf_module):
                if not key.startswith('_'):
                    conf[key] = getattr(conf_module, key)

    if 'source_file_parser' not in conf: # TODO: rename `association_file_parser`, relegate source_file_parser to an alias
        conf['source_file_parser'] = 'epacts'

    def _configure_cache():
        # if conf['cache'] exists and is Falsey, don't cache.
        if 'cache' in conf and not conf['cache']:
            del conf['cache']
            return
        # if it doesn't exist, use the default.
        if 'cache' not in conf:
            conf['cache'] = '~/.pheweb/cache'

        conf['cache'] = os.path.expanduser(conf['cache'])
        # check whether dir exists
        if not os.path.isdir(conf['cache']):
            try:
                mkdir_p(conf['cache'])
            except:
                print("Warning: caching is disabled because the directory {!r} can't be created.\n".format(conf['cache']) +
                      "If you don't want caching, set `cache = False` in your config.py.")
                del conf['cache']
                return
        if not os.access(conf['cache'], os.R_OK):
            print('Warning: the directory {!r} is configured to be your cache directory but it is not readable.\n'.format(conf['cache']) +
                  "If you don't want caching, set `cache = False` in your config.py.")
            del conf['cache']
    _configure_cache()
ensure_conf_is_loaded()