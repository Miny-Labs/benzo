// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract TransferCircuitGroth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 17799851660183724029084951004388111683111892093599549449189397099216195853456;
    uint256 constant deltax2 = 13051152916714926291118871138766937211576829245446139001731410818223213302298;
    uint256 constant deltay1 = 17222616292206727292318991538769337904353289466808608599301262828443405713735;
    uint256 constant deltay2 = 13877024218659993123791738891749049529111711905423188669494349171982730226238;

    
    uint256 constant IC0x = 11078456175176508947665060839367063181390473473270508006260718733884763446509;
    uint256 constant IC0y = 6041753414651001127438360352721137264917051499794520184043293475204165190685;
    
    uint256 constant IC1x = 15162904757480315297547642942646568889101029164132171480256830884259150251283;
    uint256 constant IC1y = 5543236365374398176471504758808152977042933422387633848583378303299793270756;
    
    uint256 constant IC2x = 17328060769291355736429270023867089282242463190765930364066672240606322731528;
    uint256 constant IC2y = 16889028711432227360380575065980535632722375252171627947743748499665179759152;
    
    uint256 constant IC3x = 8534951274187844857754798765054711469756707542878193818609654720983424682295;
    uint256 constant IC3y = 8945913628923857906349475216922865350407303486167834270986003060482590360541;
    
    uint256 constant IC4x = 15451872962493168690150192361017318203301132735619727602712141758148948638807;
    uint256 constant IC4y = 3257041611034212540028719703800773323519734826811773698850078555263697393038;
    
    uint256 constant IC5x = 16501527896500369578902237454836690085885521711966021988157538332449691146412;
    uint256 constant IC5y = 16277901177749764148365216633606366116251292755281475194298759272707407824018;
    
    uint256 constant IC6x = 10378146563933233933703734244718759999027501367391365750021798315897563444591;
    uint256 constant IC6y = 6842563751857803307953802478770242999171402515835370020586447923920873099219;
    
    uint256 constant IC7x = 20352721715392263662971537971767346903027859101481416488967643016592847282380;
    uint256 constant IC7y = 14260881413352838566197164407396428620727197892843554333450508049100242677628;
    
    uint256 constant IC8x = 21057739816355151565092401964767622282102551265481668904500681957228063344238;
    uint256 constant IC8y = 16180780523793713645254963281457716926007937226125045923262954827309238281194;
    
    uint256 constant IC9x = 14537516127080012005197736574343683034537191970611258246890082854105324760933;
    uint256 constant IC9y = 18442918359750026099515052740471376065513561505084248781730547784475549682043;
    
    uint256 constant IC10x = 9945678304537190581884908568330352663212605281307078311554845796978128487311;
    uint256 constant IC10y = 9922952547073080040816726971142108048165624682232524310828932207260681346925;
    
    uint256 constant IC11x = 121018551111798889520476374750956766867835537125258291153678626712032749835;
    uint256 constant IC11y = 29265305386115914605361057732389333018602730942100360415826037370925178043;
    
    uint256 constant IC12x = 19393638291779014670875425462009705376277440547297152509532737472607672105229;
    uint256 constant IC12y = 12637387498267415299358604851073087307458804722402979421904536853588103603115;
    
    uint256 constant IC13x = 19535226022618801566939497106610112373065946755466822996888611481583748235579;
    uint256 constant IC13y = 18338463551063409694995636016403970595398232669703454914987172540276159653613;
    
    uint256 constant IC14x = 8008700345935321927788580584227425845966574602899033915258149217767990418718;
    uint256 constant IC14y = 185856258559502906253092650522696470738095546583256434424552656167093996151;
    
    uint256 constant IC15x = 7820954574137895573811525844670273368496497357173205474113176992404687726697;
    uint256 constant IC15y = 956512349033607095044956195378412396626953742914598187567649677456879320228;
    
    uint256 constant IC16x = 15573333703789237575530866563016649620625650785245004564133502761898657171416;
    uint256 constant IC16y = 4318045992191734813427473662920467578914718989290966190779465757655054024866;
    
    uint256 constant IC17x = 14251137277887630388639941167105402370548590355743069148064181443318051385186;
    uint256 constant IC17y = 3156000259325297871563018277964544792850822239901608666349236165443650945279;
    
    uint256 constant IC18x = 5872390235919681263129087861488743087046671364741206348090856282223602944462;
    uint256 constant IC18y = 16668195091836658784208651432085131085595308441293778882239710806888813163568;
    
    uint256 constant IC19x = 18514753246385905128088201279079181382420042068951125186140903026107781270079;
    uint256 constant IC19y = 12671409848969278422503585680858897360251449228569325218012677111477592298915;
    
    uint256 constant IC20x = 14795534685259818800016539466295714973315210330368104927561037919830323460988;
    uint256 constant IC20y = 2713630188989527621944627278467445252191128824455445277832095608562212679464;
    
    uint256 constant IC21x = 14146928308724125026725614632454585439232772772913032956834281111360859175326;
    uint256 constant IC21y = 11696713101615308965286605927940420687716057765241336395590899692577157174575;
    
    uint256 constant IC22x = 2235128209339941496221360806283506282754206127175685907922436886644178469613;
    uint256 constant IC22y = 6082007467329063519640234159158138154643669546952627326867255812484441045661;
    
    uint256 constant IC23x = 4778277300486848528134752164009065478749360605826055092389954662792598494091;
    uint256 constant IC23y = 3024652709566317167468475499107319235166534387809203994443662489737171429439;
    
    uint256 constant IC24x = 20553119678962413077240456112807143224561227202753679727141414460261204287602;
    uint256 constant IC24y = 353033850139697523308575010181001615711175280648155651143918443424069251681;
    
    uint256 constant IC25x = 12320369853960213401201536713826981257726604458607453897067807791457490307319;
    uint256 constant IC25y = 12895878247228443034004154694080502857256319561028939353010666652708930585511;
    
    uint256 constant IC26x = 772255132879173785462217420966153746864602649093557997703481412106975381771;
    uint256 constant IC26y = 7590818764269556518156184415909156972825437157984074557355089651665498212893;
    
    uint256 constant IC27x = 15656520006351949412863400564011439085326031727827048952749172502151384928426;
    uint256 constant IC27y = 9520418046246602777065803395409630022848696572538622647916460498453086071681;
    
    uint256 constant IC28x = 203389407731559972686963839373673159907560284831081500283956869457261227598;
    uint256 constant IC28y = 7452820531660814855014532611843194786449585917006722468041952200572306428747;
    
    uint256 constant IC29x = 1294403555916294449795173178919244618506718557207433405402610910324041999043;
    uint256 constant IC29y = 3417552333935828954715155980714171844696841479989449134034592386673267645237;
    
    uint256 constant IC30x = 4057510152773123091521740504550701903278483323514428067579004823698831606746;
    uint256 constant IC30y = 255222888879429197662829341108999392987181390679120827600125684828907967217;
    
    uint256 constant IC31x = 16993165161373202096858097803614125959054307247005919250330093739286073007809;
    uint256 constant IC31y = 1630518864111342581154347255970093862315458024055440432677999240937750277089;
    
    uint256 constant IC32x = 1342624472930637816128297475680967043884959574033915950794605458813343173455;
    uint256 constant IC32y = 10644443477057701293111051850964191288457516065268084028669805887784546476470;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[32] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                
                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))
                
                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))
                
                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))
                
                g1_mulAccC(_pVk, IC26x, IC26y, calldataload(add(pubSignals, 800)))
                
                g1_mulAccC(_pVk, IC27x, IC27y, calldataload(add(pubSignals, 832)))
                
                g1_mulAccC(_pVk, IC28x, IC28y, calldataload(add(pubSignals, 864)))
                
                g1_mulAccC(_pVk, IC29x, IC29y, calldataload(add(pubSignals, 896)))
                
                g1_mulAccC(_pVk, IC30x, IC30y, calldataload(add(pubSignals, 928)))
                
                g1_mulAccC(_pVk, IC31x, IC31y, calldataload(add(pubSignals, 960)))
                
                g1_mulAccC(_pVk, IC32x, IC32y, calldataload(add(pubSignals, 992)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            
            checkField(calldataload(add(_pubSignals, 704)))
            
            checkField(calldataload(add(_pubSignals, 736)))
            
            checkField(calldataload(add(_pubSignals, 768)))
            
            checkField(calldataload(add(_pubSignals, 800)))
            
            checkField(calldataload(add(_pubSignals, 832)))
            
            checkField(calldataload(add(_pubSignals, 864)))
            
            checkField(calldataload(add(_pubSignals, 896)))
            
            checkField(calldataload(add(_pubSignals, 928)))
            
            checkField(calldataload(add(_pubSignals, 960)))
            
            checkField(calldataload(add(_pubSignals, 992)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
