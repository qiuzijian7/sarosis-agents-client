# -*- coding: utf-8 -*-
"""pie_br_flow — 兼容垫片（旧引导方式仍然可用）。

实现已迁至 ``Content/GameScript/ueflow/br.py``（GameScript 独立仓库 gr_user_script）。
新代码请直接::

    from GameScript.ueflow import br as pbr

本文件保留是为了旧 session / 旧 recipe 里 ``import pie_br_flow as pbr`` 继续可用：
把当前模块名替换成 GameScript.ueflow.br 模块对象，所有函数/常量（含 _iter 等私有名）原样保留。
"""
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(os.path.dirname(os.path.dirname(_here)))
if _root not in sys.path:
    sys.path.insert(0, _root)

from GameScript.ueflow import br as _br

sys.modules[__name__] = _br
